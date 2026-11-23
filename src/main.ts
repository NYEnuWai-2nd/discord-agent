import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentForever } from './agent.ts';
import { loadConfig, loadEnv, type Env } from './config.ts';
import { createDiscord } from './discord.ts';
import { Inbox } from './inbox.ts';
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
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${jstPrefix()} ${signal} を受信したため終了します...`);

    const forceTimer = setTimeout(() => {
      console.error(`${jstPrefix()} 終了処理がタイムアウトしたため強制終了します`);
      process.exit(0);
    }, 2_000);
    forceTimer.unref();

    patrol?.stop();
    toolServer?.stop();
    void discord.destroy().finally(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
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
  const brain = process.env.BOT_BRAIN?.trim() || 'claude';
  const webhookUrl = process.env.BOT_WEBHOOK_URL?.trim();
  if (brain === 'webhook' && !webhookUrl) {
    console.error(`${jstPrefix()} 環境設定エラー: BOT_BRAIN=webhook には BOT_WEBHOOK_URL が必要です`);
    process.exit(1);
  }

  const pendingDir = join(env.stateDir, 'pending');
  const handled = new Set<string>();

  async function enqueueWebhookItem(id: string, payload: unknown): Promise<boolean> {
    try {
      mkdirSync(pendingDir, { recursive: true });
      const tmp = join(pendingDir, `${id}.json.tmp`);
      writeFileSync(tmp, JSON.stringify(payload, null, 2));
      renameSync(tmp, join(pendingDir, `${id}.json`));
    } catch (err) {
      console.error(`${jstPrefix()} 受信内容の保存に失敗:`, err);
      return false;
    }
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

  discord.onInbound((text, chatId) => {
    const firstLine = (text.split(/\r?\n/, 1)[0] ?? '').slice(0, 200);
    console.log(`${jstPrefix()} 受信: ${firstLine}`);
    if (brain !== 'webhook') {
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
  if (brain === 'webhook') {
    toolServer = startToolServer({
      tools: discord.tools,
      stateDir: env.stateDir,
      workspace: env.workspace,
      getConfig: () => loadConfig(env.configPath),
    });
    console.log(`${jstPrefix()} ツールサーバー: 127.0.0.1:${toolServer.port}`);
    if (env.patrolMinutes > 0) {
      console.log(`${jstPrefix()} 巡回: 有効 (${env.patrolMinutes} 分間隔)`);
      patrol = startPatrol({
        intervalMs: env.patrolMinutes * 60_000,
        getConfig: () => loadConfig(env.configPath),
        fetchSnapshot: (channelId) => discord.fetchSnapshot(channelId),
        handled,
        enqueue: async (channels) => {
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
    // 頭脳は外部（webhook の先）。Discord の受信だけを続ける
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
