import { readFileSync } from 'node:fs';
import { AcpClient, clearAcpSessionId, loadAcpModel, saveAcpModel } from './acp-client.ts';
import { formatJournalBody, type JournalItem } from './journal.ts';

export type AcpBrainInboundItem = {
  kind: 'inbound';
  inbound: string;
  history: string;
  chatId?: string;
};

export type AcpBrainItem =
  | AcpBrainInboundItem
  | { kind: 'patrol'; channels: Array<{ chatId: string; history: string }> }
  | JournalItem;

export type AcpBrainOptions = {
  command: string;
  cwd: string;
  stateDir: string;
  model?: string;
  instructionsPath: string;
  stateFilePath?: string;
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
const MAX_INBOUND_BATCH = 5;

const PROMPT_FOOTER =
  '指示書の手順に従って判断し、返すなら tool.ts で返す。返さないなら何もしない。この会話への最終回答は 1 行でよい。';
const BATCH_PROMPT_FOOTER =
  '上の各メッセージについて、指示書の手順に従ってそれぞれ判断し、返すものは tool.ts で個別に（各 message_id を --reply_to に付けて）返す。返さないものには何もしない。最終回答は 1 行でよい。';
const JOURNAL_PROMPT_FOOTER =
  '指示書の『日誌』の節に従って要約し、tool.ts write_journal で書く。Discord には何も送らない。最終回答は 1 行でよい。';

type QueueEntry = {
  item: AcpBrainItem;
  enqueuedAt: number;
};

function itemPriority(item: AcpBrainItem): number {
  if (item.kind === 'inbound') return 0;
  if (item.kind === 'journal') return 1;
  return 2;
}

function resolveInboundChatId(item: AcpBrainInboundItem): string | undefined {
  if (item.chatId !== undefined && item.chatId !== '') {
    return item.chatId;
  }
  const match = /\bchat_id="([^"]+)"/.exec(item.inbound);
  return match?.[1];
}

/** `take.ts` と同じ形式で ACP エージェント向けプロンプト本文を組み立てる */
export function formatAcpPrompt(
  itemOrBatch: AcpBrainItem | AcpBrainInboundItem[],
  instructionsPath: string,
  includeIntro: boolean,
  stateContent?: string,
): string {
  let body: string;
  let footer = PROMPT_FOOTER;
  if (Array.isArray(itemOrBatch)) {
    if (itemOrBatch.length === 0) {
      throw new Error('formatAcpPrompt: empty inbound batch');
    }
    if (itemOrBatch.length === 1) {
      const single = itemOrBatch[0]!;
      body = [
        '=== inbound ===',
        single.inbound,
        '=== history（古い順。me は bot 自身） ===',
        single.history,
      ].join('\n');
    } else {
      const total = itemOrBatch.length;
      const lines: string[] = [];
      for (let i = 0; i < total; i++) {
        const cur = itemOrBatch[i]!;
        const next = i + 1 < total ? itemOrBatch[i + 1] : undefined;
        const curChatId = resolveInboundChatId(cur);
        const nextChatId = next ? resolveInboundChatId(next) : undefined;
        const sameNextChat =
          curChatId !== undefined && nextChatId !== undefined && curChatId === nextChatId;

        lines.push(`=== inbound ${i + 1}/${total} ===`);
        lines.push(cur.inbound);
        if (!sameNextChat) {
          lines.push('=== history（古い順。me は bot 自身） ===');
          lines.push(cur.history);
        }
      }
      body = lines.join('\n');
      footer = BATCH_PROMPT_FOOTER;
    }
  } else if (itemOrBatch.kind === 'patrol') {
    const lines = ['=== patrol ==='];
    for (const ch of itemOrBatch.channels) {
      lines.push(`--- chat_id=${ch.chatId} ---`);
      lines.push(ch.history);
    }
    body = lines.join('\n');
  } else if (itemOrBatch.kind === 'journal') {
    body = formatJournalBody(itemOrBatch);
    footer = JOURNAL_PROMPT_FOOTER;
  } else {
    body = [
      '=== inbound ===',
      itemOrBatch.inbound,
      '=== history（古い順。me は bot 自身） ===',
      itemOrBatch.history,
    ].join('\n');
  }

  const parts: string[] = [];
  if (includeIntro) {
    parts.push(
      `最初に ${instructionsPath} を読み、ACP モードの節に従うこと。現在の状態は各発言の先頭に添付されるので、現在の状態.md を読み直す必要はない。`,
    );
  }
  if (stateContent !== undefined) {
    const trimmedState = stateContent.replace(/(?:\r?\n)+$/, '');
    parts.push(`=== 現在の状態（bot が添付。読み直し不要） ===\n${trimmedState}`);
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

  const queue: QueueEntry[] = [];
  let warnedStateFile = false;
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

  function readStateFile(): string | undefined {
    if (!opts.stateFilePath) return undefined;
    try {
      const content = readFileSync(opts.stateFilePath, 'utf8');
      warnedStateFile = false;
      return content;
    } catch (err) {
      if (!warnedStateFile) {
        warnedStateFile = true;
        const msg = err instanceof Error ? err.message : String(err);
        log(`警告: 状態ファイルを読み込めません (${opts.stateFilePath}): ${msg}`);
      }
      return undefined;
    }
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

      const batchEntries: QueueEntry[] = [];
      if (queue[0]!.item.kind === 'inbound') {
        while (
          batchEntries.length < MAX_INBOUND_BATCH &&
          queue.length > 0 &&
          queue[0]!.item.kind === 'inbound'
        ) {
          batchEntries.push(queue.shift()!);
        }
      } else {
        batchEntries.push(queue.shift()!);
      }

      const oldestEnqueuedAt = Math.min(...batchEntries.map((e) => e.enqueuedAt));
      const firstItem = batchEntries[0]!.item;
      const kindLabel =
        firstItem.kind === 'inbound' ? `inbound×${batchEntries.length}` : firstItem.kind;
      const promptTarget =
        firstItem.kind === 'inbound'
          ? batchEntries.map((e) => e.item as AcpBrainInboundItem)
          : firstItem;
      const stateContent = readStateFile();
      const promptText = formatAcpPrompt(
        promptTarget,
        opts.instructionsPath,
        needsIntro,
        stateContent,
      );
      needsIntro = false;
      inTurn = true;
      const promptStartMs = Date.now();
      const waitSec = Math.max(0, (promptStartMs - oldestEnqueuedAt) / 1000).toFixed(1);

      try {
        const res = await activeClient.prompt(promptText);
        turnsInSession += 1;
        crashCount = 0;
        const procSec = Math.max(0, (Date.now() - promptStartMs) / 1000).toFixed(1);
        log(
          `ACP ターン完了: 種別=${kindLabel} 待ち=${waitSec} 処理=${procSec} stopReason=${res.stopReason}`,
        );
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
      if (item.kind === 'patrol' && queue.some((e) => e.item.kind === 'inbound')) {
        log('巡回: メンション待ちのため破棄');
        return;
      }
      if (item.kind === 'inbound') {
        let droppedPatrol = false;
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i]!.item.kind === 'patrol') {
            queue.splice(i, 1);
            droppedPatrol = true;
          }
        }
        if (droppedPatrol) {
          log('巡回: メンション待ちのため破棄');
        }
      }
      if (queue.length >= maxQueueSize) {
        const dropped = queue.shift();
        log(
          `警告: ACP キュー上限 (${maxQueueSize}) に達したため古いアイテム (${dropped?.item.kind ?? 'unknown'}) を破棄します`,
        );
      }
      const entry: QueueEntry = { item, enqueuedAt: Date.now() };
      const prio = itemPriority(item);
      let insertIdx = queue.length;
      for (let i = 0; i < queue.length; i++) {
        if (itemPriority(queue[i]!.item) > prio) {
          insertIdx = i;
          break;
        }
      }
      queue.splice(insertIdx, 0, entry);
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
      return queue.some((entry) => entry.item.kind === 'patrol');
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
