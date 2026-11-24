import { AcpClient, clearAcpSessionId, loadAcpModel, saveAcpModel } from './acp-client.ts';
import { formatJournalBody, type JournalItem } from './journal.ts';

export type AcpBrainItem =
  | { kind: 'inbound'; inbound: string; history: string }
  | { kind: 'patrol'; channels: Array<{ chatId: string; history: string }> }
  | JournalItem;

export type AcpBrainOptions = {
  command: string;
  cwd: string;
  stateDir: string;
  model?: string;
  instructionsPath: string;
  promptTimeoutSec?: number;
  maxTurns?: number;
  fresh?: boolean;
  cancelGraceMs?: number;
  restartDelaysMs?: number[];
  maxQueueSize?: number;
  log?: (msg: string) => void;
  onTurnEnd?: () => void;
};

export type AcpBrain = {
  enqueue(item: AcpBrainItem): void;
  close(): void;
  drain(timeoutMs: number): Promise<boolean>;
  hasPendingPatrol(): boolean;
  requestModel(modelId: string): Promise<string>;
  getModels(): { current?: string; available: string[] };
  stop(): Promise<void>;
};

const DEFAULT_PROMPT_TIMEOUT_SEC = 300;
const DEFAULT_MAX_TURNS = 200;
const DEFAULT_MAX_QUEUE_SIZE = 50;
const DEFAULT_RESTART_DELAYS_MS = [5_000, 15_000, 60_000, 180_000, 300_000];
const STABLE_UPTIME_MS = 60_000;

const PROMPT_FOOTER =
  '指示書の手順に従って判断し、返すなら tool.ts で返す。返さないなら何もしない。この会話への最終回答は 1 行でよい。';
const JOURNAL_PROMPT_FOOTER =
  '指示書の『日誌』の節に従って要約し、tool.ts write_journal で書く。Discord には何も送らない。最終回答は 1 行でよい。';

/** `take.ts` と同じ形式で ACP エージェント向けプロンプト本文を組み立てる */
export function formatAcpPrompt(
  item: AcpBrainItem,
  instructionsPath: string,
  includeIntro: boolean,
): string {
  let body: string;
  let footer = PROMPT_FOOTER;
  if (item.kind === 'patrol') {
    const lines = ['=== patrol ==='];
    for (const ch of item.channels) {
      lines.push(`--- chat_id=${ch.chatId} ---`);
      lines.push(ch.history);
    }
    body = lines.join('\n');
  } else if (item.kind === 'journal') {
    body = formatJournalBody(item);
    footer = JOURNAL_PROMPT_FOOTER;
  } else {
    body = [
      '=== inbound ===',
      item.inbound,
      '=== history（古い順。me は bot 自身） ===',
      item.history,
    ].join('\n');
  }

  const parts: string[] = [];
  if (includeIntro) {
    parts.push(`最初に ${instructionsPath} を読み、ACP モードの節に従うこと。`);
  }
  parts.push(body);
  parts.push(footer);
  return parts.join('\n\n');
}

/**
 * 1 つの ACP セッションを維持しながら受信・巡回アイテムを直列処理する頭脳を起動する。
 * 子プロセス終了時はバックオフ付きで自動再起動し、その間の着信はキューに保持する。
 */
export function createAcpBrain(opts: AcpBrainOptions): AcpBrain {
  const promptTimeoutSec = opts.promptTimeoutSec ?? DEFAULT_PROMPT_TIMEOUT_SEC;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxQueueSize = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  const restartDelaysMs =
    opts.restartDelaysMs && opts.restartDelaysMs.length > 0
      ? opts.restartDelaysMs
      : DEFAULT_RESTART_DELAYS_MS;
  const log = opts.log ?? ((msg: string) => console.log(msg));

  const queue: AcpBrainItem[] = [];
  let stopped = false;
  let closed = false;
  let activeClient: AcpClient | undefined;
  let clientReady = false;
  let inTurn = false;
  let selectedModel: string | undefined = loadAcpModel(opts.stateDir) ?? opts.model;
  let pendingModelAfterTurn: string | undefined;
  let pendingModelOp:
    | {
        modelId: string;
        resolve: (msg: string) => void;
        reject: (err: Error) => void;
      }
    | undefined;
  let wakeupResolve: (() => void) | undefined;
  let sleepCancel: (() => void) | undefined;
  const drainWaiters = new Set<() => void>();

  function isIdle(): boolean {
    return queue.length === 0 && !inTurn && !pendingModelOp;
  }

  function notifyDrainWaiters(): void {
    for (const notify of Array.from(drainWaiters)) {
      notify();
    }
  }

  function wake(): void {
    if (wakeupResolve) {
      const resolve = wakeupResolve;
      wakeupResolve = undefined;
      resolve();
    }
  }

  function waitForSignal(): Promise<void> {
    return new Promise<void>((resolve) => {
      wakeupResolve = resolve;
    });
  }

  function sleepCancellable(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        sleepCancel = undefined;
        resolve();
      }, ms);
      sleepCancel = () => {
        clearTimeout(timer);
        sleepCancel = undefined;
        resolve();
      };
    });
  }

  async function runLoop(): Promise<void> {
    let attempt = 0;
    let crashCount = 0;
    let clientExited = false;
    let startedAt = 0;
    let needsIntro = false;
    let turnsInSession = 0;

    while (!stopped) {
      if (!activeClient || clientExited) {
        clientReady = false;
        if (pendingModelOp) {
          const op = pendingModelOp;
          pendingModelOp = undefined;
          selectedModel = op.modelId;
          saveAcpModel(opts.stateDir, op.modelId);
          op.resolve(`モデルを ${op.modelId} に設定しました（再起動時に適用）`);
        }

        if (crashCount > 0) {
          const idx = Math.min(crashCount - 1, restartDelaysMs.length - 1);
          const delayMs = restartDelaysMs[idx]!;
          log(`${Math.round(delayMs / 1000)} 秒後に ACP エージェントを再起動します...`);
          await sleepCancellable(delayMs);
          if (stopped) break;
        }

        const modelToStart = selectedModel;
        pendingModelAfterTurn = undefined;
        let thisClient: AcpClient;
        try {
          thisClient = new AcpClient({
            command: opts.command,
            cwd: opts.cwd,
            stateDir: opts.stateDir,
            model: modelToStart,
            promptTimeoutSec,
            cancelGraceMs: opts.cancelGraceMs,
            fresh: attempt === 0 ? (opts.fresh ?? false) : false,
            log,
            onExit: ({ code, signalCode }) => {
              if (activeClient !== thisClient) return;
              clientExited = true;
              clientReady = false;
              if (!stopped) {
                log(`ACP エージェントが終了しました (code=${code ?? 'null'}, signal=${signalCode ?? 'null'})`);
              }
              wake();
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`ACP クライアント生成エラー: ${msg}`);
          crashCount += 1;
          continue;
        }

        attempt += 1;
        activeClient = thisClient;
        clientExited = false;
        startedAt = Date.now();

        try {
          const startRes = await thisClient.start();
          if (stopped || activeClient !== thisClient) {
            thisClient.stop();
            break;
          }
          if (selectedModel && selectedModel !== modelToStart) {
            const avail = thisClient.getModels().available;
            if (avail.length === 0 || avail.includes(selectedModel)) {
              try {
                await thisClient.setModel(selectedModel);
                log(`ACP モデル設定: ${selectedModel}`);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log(`警告: session/set_model (${selectedModel}) に失敗しました: ${msg}`);
              }
            } else {
              log(`警告: 指定モデル "${selectedModel}" は availableModels に含まれていません`);
            }
          }
          clientReady = true;
          needsIntro = startRes.isNewSession;
          turnsInSession = 0;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`ACP セッション開始エラー: ${msg}`);
          if (activeClient === thisClient) {
            activeClient = undefined;
          }
          thisClient.stop();
          clientExited = true;
          clientReady = false;
          crashCount += 1;
          continue;
        }
      }

      if (pendingModelOp) {
        const op = pendingModelOp;
        pendingModelOp = undefined;
        try {
          const avail = activeClient.getModels().available;
          if (avail.length > 0 && !avail.includes(op.modelId)) {
            op.reject(new Error(`使えないモデル: ${op.modelId}。使えるもの: ${avail.join(', ')}`));
          } else {
            await activeClient.setModel(op.modelId);
            selectedModel = op.modelId;
            saveAcpModel(opts.stateDir, op.modelId);
            log(`ACP モデル切り替え: ${op.modelId}`);
            op.resolve(`モデルを ${op.modelId} に切り替えました`);
          }
        } catch (err) {
          op.reject(err instanceof Error ? err : new Error(String(err)));
        }
        continue;
      }

      if (queue.length === 0) {
        notifyDrainWaiters();
        await waitForSignal();
        if (clientExited && Date.now() - startedAt >= STABLE_UPTIME_MS) {
          crashCount = 0;
        }
        if (clientExited) {
          crashCount += 1;
        }
        continue;
      }

      const item = queue.shift()!;
      const promptText = formatAcpPrompt(item, opts.instructionsPath, needsIntro);
      needsIntro = false;
      inTurn = true;

      try {
        const res = await activeClient.prompt(promptText);
        turnsInSession += 1;
        crashCount = 0;
        log(`ACP ターン完了 (${turnsInSession}/${maxTurns}, stopReason=${res.stopReason})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`ACP prompt エラー: ${msg}`);
        if (clientExited) {
          if (Date.now() - startedAt >= STABLE_UPTIME_MS) {
            crashCount = 1;
          } else {
            crashCount += 1;
          }
        } else {
          turnsInSession += 1;
        }
      } finally {
        inTurn = false;
        if (!stopped && !clientExited && pendingModelAfterTurn && turnsInSession < maxTurns) {
          const nextModel = pendingModelAfterTurn;
          pendingModelAfterTurn = undefined;
          try {
            await activeClient.setModel(nextModel);
            log(`ACP モデル切り替え（ターン終了後）: ${nextModel}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`警告: ターン終了後の session/set_model (${nextModel}) に失敗しました: ${msg}`);
          }
        }
        try {
          opts.onTurnEnd?.();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`onTurnEnd エラー: ${msg}`);
        }
      }

      if (!stopped && !clientExited && turnsInSession >= maxTurns) {
        log(`ACP ターン上限 (${maxTurns}) に達したためセッションを作り直します`);
        const oldClient = activeClient;
        activeClient = undefined;
        clientReady = false;
        pendingModelAfterTurn = undefined;
        oldClient?.stop();
        clearAcpSessionId(opts.stateDir);
        turnsInSession = 0;
        crashCount = 0;
      }
    }
  }

  const loopPromise = runLoop();

  function getModels(): { current?: string; available: string[] } {
    if (!activeClient || !clientReady) {
      return {
        ...(selectedModel !== undefined ? { current: selectedModel } : {}),
        available: [],
      };
    }
    const clientModels = activeClient.getModels();
    const current = clientModels.current ?? selectedModel;
    return {
      ...(current !== undefined ? { current } : {}),
      available: clientModels.available,
    };
  }

  return {
    enqueue(item: AcpBrainItem): void {
      if (stopped || closed) return;
      if (queue.length >= maxQueueSize) {
        const dropped = queue.shift();
        log(`警告: ACP キュー上限 (${maxQueueSize}) に達したため古いアイテム (${dropped?.kind ?? 'unknown'}) を破棄します`);
      }
      queue.push(item);
      wake();
    },

    close(): void {
      closed = true;
    },

    drain(timeoutMs: number): Promise<boolean> {
      if (stopped) return Promise.resolve(false);
      if (isIdle()) return Promise.resolve(true);
      if (timeoutMs <= 0) return Promise.resolve(false);

      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          drainWaiters.delete(onNotify);
          resolve(ok);
        };
        const onNotify = () => {
          if (stopped) {
            finish(false);
          } else if (isIdle()) {
            finish(true);
          }
        };
        const timer = setTimeout(() => {
          finish(false);
        }, timeoutMs);
        drainWaiters.add(onNotify);
      });
    },

    hasPendingPatrol(): boolean {
      return queue.some((item) => item.kind === 'patrol');
    },

    async requestModel(modelId: string): Promise<string> {
      if (stopped) {
        throw new Error('AcpBrain は停止しています');
      }
      const trimmed = modelId.trim();
      if (!trimmed) {
        throw new Error('model を指定してください');
      }

      const models = getModels();
      if (models.available.length > 0 && !models.available.includes(trimmed)) {
        throw new Error(`使えないモデル: ${trimmed}。使えるもの: ${models.available.join(', ')}`);
      }

      if (inTurn) {
        selectedModel = trimmed;
        pendingModelAfterTurn = trimmed;
        saveAcpModel(opts.stateDir, trimmed);
        log(`ACP モデル切り替え予約: ${trimmed}（現在のターン終了後に適用）`);
        return `モデルを ${trimmed} に切り替えるよう予約しました（現在のターン終了後に適用）`;
      }

      if (activeClient && clientReady) {
        if (pendingModelOp) {
          pendingModelOp.reject(new Error('後続のモデル切り替え要求に上書きされました'));
          pendingModelOp = undefined;
        }
        return new Promise<string>((resolve, reject) => {
          pendingModelOp = { modelId: trimmed, resolve, reject };
          wake();
        });
      }

      selectedModel = trimmed;
      saveAcpModel(opts.stateDir, trimmed);
      log(`ACP モデルを保存しました: ${trimmed}（エージェント起動時に適用）`);
      return `モデルを ${trimmed} に設定しました（エージェント起動時に適用）`;
    },

    getModels,

    async stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        closed = true;
        clientReady = false;
        if (pendingModelOp) {
          pendingModelOp.reject(new Error('AcpBrain が停止されました'));
          pendingModelOp = undefined;
        }
        const current = activeClient;
        activeClient = undefined;
        const stopWait = current?.stop();
        sleepCancel?.();
        wake();
        notifyDrainWaiters();
        await stopWait;
      }
      await loopPromise;
    },
  };
}
