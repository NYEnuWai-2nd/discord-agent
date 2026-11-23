import { readdirSync } from 'node:fs';
import type { BotConfig } from './config.ts';

/** 巡回判定用の最小メッセージ情報 */
export type MsgLite = {
  id: string;
  authorId: string;
  isSelf: boolean;
};

const MAX_HANDLED_IDS = 1000;

/**
 * 配列内の最大 Discord Snowflake ID を BigInt で比較して返す。空なら undefined。
 */
function maxMessageId(messages: MsgLite[]): string | undefined {
  let maxId: string | undefined;
  let maxVal = -1n;
  for (const m of messages) {
    const val = BigInt(m.id);
    if (maxId === undefined || val > maxVal) {
      maxId = m.id;
      maxVal = val;
    }
  }
  return maxId;
}

/**
 * 前回確認した最新メッセージ ID（lastSeen）と今回のスナップショットを比較し、
 * 自分以外かつ未処理（handled 外）の新着があるチャンネルを抽出する。
 */
export function selectChanged(
  lastSeen: Map<string, string>,
  snapshot: Map<string, MsgLite[]>,
  handled: Set<string>,
): { changed: string[]; nextLastSeen: Map<string, string> } {
  const changed: string[] = [];
  const nextLastSeen = new Map<string, string>(lastSeen);

  for (const [channelId, messages] of snapshot) {
    const maxId = maxMessageId(messages);
    if (maxId === undefined) {
      // スナップショットが空なら以前の lastSeen をそのまま維持する
      continue;
    }

    const prevId = lastSeen.get(channelId);
    nextLastSeen.set(channelId, maxId);

    if (prevId === undefined) {
      // 初回観測は基準 ID を記録するのみで新着扱いにしない
      continue;
    }

    const prevVal = BigInt(prevId);
    const hasNew = messages.some(
      (m) => !m.isSelf && !handled.has(m.id) && BigInt(m.id) > prevVal,
    );
    if (hasNew) {
      changed.push(channelId);
    }
  }

  return { changed, nextLastSeen };
}

/**
 * pending ディレクトリ内に未処理の patrol ファイル（*-patrol.json）が存在するか返す。
 */
export function hasPendingPatrol(pendingDir: string): boolean {
  let files: string[];
  try {
    files = readdirSync(pendingDir);
  } catch {
    return false;
  }
  return files.some((f) => f.endsWith('-patrol.json'));
}

/**
 * handled セットが上限を超えないよう古い順（挿入順）に削除する。
 */
function pruneHandled(handled: Set<string>): void {
  if (handled.size <= MAX_HANDLED_IDS) return;
  let excess = handled.size - MAX_HANDLED_IDS;
  for (const id of handled) {
    handled.delete(id);
    excess -= 1;
    if (excess <= 0) break;
  }
}

/**
 * 設定から巡回対象チャンネル ID 一覧を解決する。
 * patrolChannels が空なら channels の全キー、指定ありなら channels にも含まれるもののみ返す。
 */
function resolveTargetChannels(cfg: BotConfig): string[] {
  const configured = cfg.patrolChannels ?? [];
  if (configured.length === 0) {
    return Object.keys(cfg.channels);
  }
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const id of configured) {
    if (!seen.has(id) && Object.hasOwn(cfg.channels, id)) {
      seen.add(id);
      targets.push(id);
    }
  }
  return targets;
}

/**
 * 定期巡回（patrol）を開始する。
 * 開始直後に 1 回だけ通知なしの観測を行い、以降は intervalMs ごとに新着を判定する。
 */
export function startPatrol(opts: {
  intervalMs: number;
  getConfig: () => BotConfig;
  fetchSnapshot: (channelId: string) => Promise<{ lite: MsgLite[]; history: string }>;
  handled: Set<string>;
  enqueue: (channels: { chatId: string; history: string }[]) => Promise<void>;
  log: (msg: string) => void;
}): { stop(): void } {
  let lastSeen = new Map<string, string>();
  let running = false;
  let stopped = false;

  async function runTick(silent: boolean): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const cfg = opts.getConfig();
      const targets = resolveTargetChannels(cfg);
      const snapshot = new Map<string, MsgLite[]>();
      const histories = new Map<string, string>();

      for (const channelId of targets) {
        if (stopped) return;
        try {
          const res = await opts.fetchSnapshot(channelId);
          snapshot.set(channelId, res.lite);
          histories.set(channelId, res.history);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts.log(`巡回チャンネル取得エラー (${channelId}): ${msg}`);
        }
      }

      if (stopped) return;

      const { changed, nextLastSeen } = selectChanged(lastSeen, snapshot, opts.handled);
      lastSeen = nextLastSeen;
      pruneHandled(opts.handled);

      if (silent) return;

      if (changed.length > 0) {
        opts.log(`巡回: ${changed.length} チャンネルに新着`);
        await opts.enqueue(
          changed.map((chatId) => ({
            chatId,
            history: histories.get(chatId) ?? '',
          })),
        );
      } else {
        opts.log('巡回: 新着なし');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log(`巡回処理エラー: ${msg}`);
    } finally {
      running = false;
    }
  }

  // 起動直後は通知せず、各チャンネルの最新 ID だけを観測する
  void runTick(true);

  const timer = setInterval(() => {
    void runTick(false);
  }, opts.intervalMs);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
