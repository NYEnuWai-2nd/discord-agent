import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAcpBrain, type AcpBrain } from './acp-brain.ts';
import { runAgentForever } from './agent.ts';
import { loadAcpEnv, loadConfig, loadEnv, resolveBrainKind, type AcpEnv, type BrainKind, type Env } from './config.ts';
import { createDiscord } from './discord.ts';
import { Inbox } from './inbox.ts';
import { collectAndEnqueueJournal, startDailyJournalScheduler, type JournalReason } from './journal.ts';
import { hasPendingPatrol, startPatrol } from './patrol.ts';
import { startToolServer } from './tool-server.ts';
import { createDiscordMcpServer } from './tools.ts';

/** JST (Asia/Tokyo) の [HH:MM:SS] タイムスタンプを返す */
function jstPrefix(): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
  return `[${time}]`;
}

/** take.ts --wait の心拍がこれより新しければ Gemini は常駐中とみなす（処理中の 1 件ぶんの時間も見込む） */
const RESIDENT_FRESH_MS = 90_000;

async function main(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${jstPrefix()} 環境設定エラー: ${msg}`);
    process.exit(1);
  }

  // Agent SDK が起動する Claude プロセスは環境変数を引き継ぐ。
  // トークンが残っていると Bash の env 表示などで Discord に漏れうるので、読んだ直後に消す。
  delete process.env.DISCORD_BOT_TOKEN;

  const claudeMdPath = join(env.workspace, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    console.error(`${jstPrefix()} 警告: ワークスペースに CLAUDE.md が見つかりません (${claudeMdPath})`);
  }

  const discord = createDiscord({
    env,
    getConfig: () => loadConfig(env.configPath),
  });
  const mcpServer = createDiscordMcpServer(discord.tools);
  const inbox = new Inbox();

  let toolServer: { port: number; stop(): void } | undefined;
  let patrol: { stop(): void } | undefined;
  let journalScheduler: { stop(): void } | undefined;
  let acpBrain: AcpBrain | undefined;
  let brain: BrainKind = 'claude';
  let webhookUrl: string | undefined;
  const pendingDir = join(env.stateDir, 'pending');
  const handled = new Set<string>();

  function savePendingItem(id: string, payload: unknown): boolean {
    try {
      mkdirSync(pendingDir, { recursive: true });
      const tmp = join(pendingDir, `${id}.json.tmp`);
      writeFileSync(tmp, JSON.stringify(payload, null, 2));
      renameSync(tmp, join(pendingDir, `${id}.json`));
      return true;
    } catch (err) {
      console.error(`${jstPrefix()} 受信内容の保存に失敗:`, err);
      return false;
    }
  }

  async function notifyWebhook(id: string): Promise<boolean> {
    // Gemini が常駐中（take.ts --wait の心拍が新しい）なら、ファイルを置くだけで webhook は省く
    try {
      const hb = JSON.parse(readFileSync(join(env.stateDir, 'resident.json'), 'utf8')) as { at?: number };
      if (typeof hb.at === 'number' && Date.now() - hb.at < RESIDENT_FRESH_MS) {
        console.log(`${jstPrefix()} Gemini 常駐中のため webhook を省略`);
        return true;
      }
    } catch {
      // 心拍ファイルが無い・壊れている → 常駐していないとみなす
    }
    try {
      const res = await fetch(webhookUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      console.log(`${jstPrefix()} webhook 転送: HTTP ${res.status}`);
      return true;
    } catch (err) {
      console.error(`${jstPrefix()} webhook 転送に失敗:`, err);
      return false;
    }
  }

  async function enqueueWebhookItem(id: string, payload: unknown): Promise<boolean> {
    if (!savePendingItem(id, payload)) return false;
    return notifyWebhook(id);
  }

  async function dispatchJournal(reason: JournalReason): Promise<boolean> {
    if (brain === 'claude') return false;
    return collectAndEnqueueJournal({
      reason,
      stateDir: env.stateDir,
      getConfig: () => loadConfig(env.configPath),
      fetchMessages: (channelId) => discord.tools.fetchMessages({ channel: channelId, limit: 100 }),
      getChannelName: async (channelId) => {
        const ch = await discord.client.channels.fetch(channelId);
        return ch && 'name' in ch && typeof ch.name === 'string' ? ch.name : undefined;
      },
      enqueue: async (item) => {
        if (brain === 'acp') {
          if (!acpBrain) return false;
          acpBrain.enqueue(item);
          return true;
        }
        const id = `${Date.now()}-journal`;
        const saved = savePendingItem(id, item);
        if (saved) {
          await notifyWebhook(id);
        }
        return saved;
      },
      log: (msg) => console.log(`${jstPrefix()} ${msg}`),
    });
  }

  let shuttingDown = false;
  let forceExitRequested = false;
  let activeForceTimer: ReturnType<typeof setTimeout> | undefined;

  const finishTeardown = (forceTimeoutMs: number) => {
    if (activeForceTimer !== undefined) {
      clearTimeout(activeForceTimer);
    }
    const forceTimer = setTimeout(() => {
      console.error(`${jstPrefix()} 終了処理がタイムアウトしたため強制終了します`);
      process.exit(0);
    }, forceTimeoutMs);
    forceTimer.unref();
    activeForceTimer = forceTimer;

    acpBrain?.close();
    void acpBrain?.stop();
    patrol?.stop();
    journalScheduler?.stop();
    toolServer?.stop();
    void discord.destroy().finally(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      if (!forceExitRequested) {
        forceExitRequested = true;
        console.log(`${jstPrefix()} ${signal} を再受信したため即終了します`);
        finishTeardown(2_000);
      }
      return;
    }
    shuttingDown = true;
    console.log(`${jstPrefix()} ${signal} を受信したため終了します...`);

    patrol?.stop();
    journalScheduler?.stop();

    if (brain === 'acp' && env.journalOnExit && acpBrain) {
      const timeoutMs = env.journalExitTimeoutSec * 1000;
      const forceTimer = setTimeout(() => {
        console.error(`${jstPrefix()} 終了処理がタイムアウトしたため強制終了します`);
        process.exit(0);
      }, timeoutMs + 5_000);
      forceTimer.unref();
      activeForceTimer = forceTimer;

      void (async () => {
        try {
          const dispatched = await dispatchJournal('shutdown');
          acpBrain.close();
          if (forceExitRequested) return;
          if (dispatched) {
            console.log(`${jstPrefix()} 日誌を書いてから終了します（もう一度 Ctrl+C で即終了）`);
            const drained = await acpBrain.drain(timeoutMs);
            if (!drained && !forceExitRequested) {
              console.error(
                `${jstPrefix()} 日誌の終了待機がタイムアウトしました (${env.journalExitTimeoutSec} 秒)`,
              );
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${jstPrefix()} 終了時日誌エラー: ${msg}`);
          acpBrain.close();
        }

        if (forceExitRequested) return;
        finishTeardown(2_000);
      })();
      return;
    }

    finishTeardown(2_000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error(`${jstPrefix()} 未処理の Promise 拒否:`, reason);
  });
  process.on('uncaughtException', (err) => {
    console.error(`${jstPrefix()} 未捕捉の例外:`, err);
  });

  // BOT_BRAIN=webhook: 頭脳を呼ばず、受信内容と直近の履歴を webhook に転送する（T3 Code の予約タスク経由で Gemini が返す試作）
  // BOT_BRAIN=acp: 汎用 ACP エージェントを子プロセス起動し、単一セッションへ直列に prompt を送る
  try {
    brain = resolveBrainKind();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${jstPrefix()} 環境設定エラー: ${msg}`);
    process.exit(1);
  }

  webhookUrl = process.env.BOT_WEBHOOK_URL?.trim();
  if (brain === 'webhook' && !webhookUrl) {
    console.error(`${jstPrefix()} 環境設定エラー: BOT_BRAIN=webhook には BOT_WEBHOOK_URL が必要です`);
    process.exit(1);
  }

  let acpEnv: AcpEnv | undefined;
  if (brain === 'acp') {
    try {
      acpEnv = loadAcpEnv(env.workspace);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${jstPrefix()} 環境設定エラー: ${msg}`);
      process.exit(1);
    }
  }

  discord.onInbound((text, chatId) => {
    if (shuttingDown) {
      discord.stopTyping();
      return;
    }
    const firstLine = (text.split(/\r?\n/, 1)[0] ?? '').slice(0, 200);
    console.log(`${jstPrefix()} 受信: ${firstLine}`);
    if (brain === 'claude') {
      inbox.push(text);
      return;
    }
    const messageId = /message_id="(\d+)"/.exec(text)?.[1];
    if (messageId) {
      handled.add(messageId);
      if (handled.size > 1000) {
        const oldest = handled.values().next().value;
        if (oldest !== undefined) handled.delete(oldest);
      }
    }
    void (async () => {
      let history = '';
      try {
        history = await discord.tools.fetchMessages({ channel: chatId, limit: 15 });
      } catch (err) {
        console.error(`${jstPrefix()} 履歴の取得に失敗:`, err);
      }
      if (shuttingDown) {
        discord.stopTyping();
        return;
      }
      if (brain === 'acp') {
        if (!acpBrain) {
          discord.stopTyping();
          return;
        }
        acpBrain.enqueue({ kind: 'inbound', inbound: text, history });
        return;
      }
      // T3 の予約タスクは webhook の本文をプロンプトに入れないので、受信内容はファイルに置き、
      // webhook は「起きろ」の合図だけにする。Gemini は scripts/take.ts で 1 件ずつ取り出す。
      const id = `${Date.now()}-${messageId ?? 'unknown'}`;
      const ok = await enqueueWebhookItem(id, { inbound: text, history });
      if (!ok) {
        discord.stopTyping();
      }
    })();
  });

  await discord.login();
  console.log(`${jstPrefix()} Discord 接続: ${discord.client.user?.tag ?? 'unknown'}`);

  console.log(`${jstPrefix()} 頭脳: ${brain}`);
  if (brain === 'webhook' || brain === 'acp') {
    toolServer = startToolServer({
      tools: discord.tools,
      stateDir: env.stateDir,
      workspace: env.workspace,
      getConfig: () => loadConfig(env.configPath),
      ...(brain === 'acp'
        ? {
            modelControl: {
              requestModel: (modelId) => {
                if (!acpBrain) throw new Error('ACP brain が初期化されていません');
                return acpBrain.requestModel(modelId);
              },
              getModels: () => {
                if (!acpBrain) throw new Error('ACP brain が初期化されていません');
                return acpBrain.getModels();
              },
            },
          }
        : {}),
    });
    console.log(`${jstPrefix()} ツールサーバー: 127.0.0.1:${toolServer.port}`);

    if (brain === 'acp' && acpEnv) {
      acpBrain = createAcpBrain({
        command: acpEnv.command,
        cwd: acpEnv.cwd,
        stateDir: env.stateDir,
        model: acpEnv.model,
        instructionsPath: acpEnv.instructionsPath,
        promptTimeoutSec: acpEnv.promptTimeoutSec,
        maxTurns: acpEnv.maxTurns,
        fresh: env.fresh,
        log: (msg) => console.log(`${jstPrefix()} ${msg}`),
        onTurnEnd: () => discord.stopTyping(),
      });
    }

    if (env.patrolMinutes > 0) {
      console.log(`${jstPrefix()} 巡回: 有効 (${env.patrolMinutes} 分間隔)`);
      patrol = startPatrol({
        intervalMs: env.patrolMinutes * 60_000,
        getConfig: () => loadConfig(env.configPath),
        fetchSnapshot: (channelId) => discord.fetchSnapshot(channelId),
        handled,
        enqueue: async (channels) => {
          if (shuttingDown) return;
          if (brain === 'acp') {
            if (!acpBrain) return;
            if (acpBrain.hasPendingPatrol()) {
              console.log(`${jstPrefix()} 巡回: 未処理の patrol が残っているためスキップ`);
              return;
            }
            acpBrain.enqueue({ kind: 'patrol', channels });
            return;
          }
          if (hasPendingPatrol(pendingDir)) {
            console.log(`${jstPrefix()} 巡回: 未処理の patrol が残っているためスキップ`);
            return;
          }
          const id = `${Date.now()}-patrol`;
          await enqueueWebhookItem(id, { kind: 'patrol', channels });
        },
        log: (msg) => console.log(`${jstPrefix()} ${msg}`),
      });
    } else {
      console.log(`${jstPrefix()} 巡回: 無効`);
    }

    if (env.journalTime) {
      console.log(`${jstPrefix()} 日誌: 毎日 ${env.journalTime}`);
      journalScheduler = startDailyJournalScheduler({
        time: env.journalTime,
        onTrigger: async () => {
          if (shuttingDown) return;
          await dispatchJournal('daily');
        },
        log: (msg) => console.log(`${jstPrefix()} ${msg}`),
      });
    } else {
      console.log(`${jstPrefix()} 日誌: 無効`);
    }
    return;
  }

  await runAgentForever({
    env,
    inbox,
    mcpServer,
    onTurnEnd: () => discord.stopTyping(),
  });
}

void main();
