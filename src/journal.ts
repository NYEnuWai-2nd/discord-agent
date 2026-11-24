import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig } from './config.ts';
import { resolveTargetChannels } from './patrol.ts';
import { formatJstDate, formatJstDateTime, writeFileAtomic } from './workspace-tools.ts';

export type JournalReason = 'daily' | 'shutdown';

export type JournalChannelHistory = {
  chatId: string;
  /** チャンネル名（取得できたときだけ） */
  name?: string;
  history: string;
};

export type JournalItem = {
  kind: 'journal';
  reason: JournalReason;
  date: string;
  since: string;
  channels: JournalChannelHistory[];
};

const JOURNAL_LAST_FILE = 'journal-last.json';
const DEFAULT_MAX_WAKEUP_DELAY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `=== journal ===` の表示本文を組み立てる（`acp-brain.ts` と `take.ts` で共通利用）。
 */
export function formatJournalBody(
  item: Pick<JournalItem, 'reason' | 'date' | 'since' | 'channels'>,
): string {
  const parsedSince = Date.parse(item.since);
  const sinceText = Number.isFinite(parsedSince)
    ? `${formatJstDateTime(new Date(parsedSince))} JST`
    : item.since;

  const lines = [
    '=== journal ===',
    `理由: ${item.reason}`,
    `日付: ${item.date}`,
    `対象期間: ${sinceText} 〜 今`,
  ];
  for (const ch of item.channels) {
    lines.push(ch.name ? `--- chat_id=${ch.chatId} name=#${ch.name} ---` : `--- chat_id=${ch.chatId} ---`);
    lines.push(ch.history);
  }
  return lines.join('\n');
}

/** `{stateDir}/journal-last.json` から前回日誌の `at` (ISO 文字列) を読む。無ければ undefined。 */
export function loadJournalLastAt(stateDir: string): string | undefined {
  try {
    const raw = readFileSync(join(stateDir, JOURNAL_LAST_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const at = (parsed as Record<string, unknown>).at;
    if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
      return undefined;
    }
    return at;
  } catch {
    return undefined;
  }
}

/** `{stateDir}/journal-last.json` に日誌取得時刻 `at` を原子的に保存する。 */
export function saveJournalLastAt(stateDir: string, at: string | Date): void {
  const iso = typeof at === 'string' ? at : at.toISOString();
  writeFileAtomic(join(stateDir, JOURNAL_LAST_FILE), JSON.stringify({ at: iso }, null, 2) + '\n');
}

/**
 * 日誌の対象開始時刻 `since` (ISO 文字列) を解決する。
 * `journal-last.json` の `at` があればそれを使い、無ければ指定日 (`YYYY-MM-DD`) の JST 0 時を返す。
 */
export function resolveJournalSince(stateDir: string, date: string): string {
  const saved = loadJournalLastAt(stateDir);
  if (saved !== undefined) {
    return saved;
  }
  return new Date(`${date}T00:00:00+09:00`).toISOString();
}

/**
 * `fetchMessages` の出力から `sinceIso` より新しい行だけを抽出する（純粋関数）。
 */
export function filterHistorySince(history: string, sinceIso: string): string {
  if (!history || history === '(no messages)') {
    return '';
  }
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) {
    return '';
  }

  const kept: string[] = [];
  for (const line of history.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^\[([^\]]+)\] /.exec(line);
    if (!match) continue;
    const msgMs = Date.parse(match[1]!);
    if (Number.isFinite(msgMs) && msgMs > sinceMs) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

/**
 * 巡回対象チャンネルから `since` 以降の発言を集め、`JournalItem` を生成する。
 * 全チャンネルで新しい発言が 0 件ならログを出して `null` を返す。
 */
export async function createJournalItem(opts: {
  reason: JournalReason;
  stateDir: string;
  getConfig: () => BotConfig;
  fetchMessages: (channelId: string) => Promise<string>;
  getChannelName?: (channelId: string) => Promise<string | undefined>;
  now?: Date;
  log?: (msg: string) => void;
}): Promise<JournalItem | null> {
  const now = opts.now ?? new Date();
  const date = formatJstDate(now);
  const since = resolveJournalSince(opts.stateDir, date);
  const targets = resolveTargetChannels(opts.getConfig());
  const channels: JournalChannelHistory[] = [];

  for (const channelId of targets) {
    try {
      const raw = await opts.fetchMessages(channelId);
      const filtered = filterHistorySince(raw, since);
      if (filtered !== '') {
        let name: string | undefined;
        try {
          name = await opts.getChannelName?.(channelId);
        } catch {
          name = undefined; // 名前が取れなくても ID だけで続ける
        }
        channels.push({ chatId: channelId, ...(name ? { name } : {}), history: filtered });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.(`日誌チャンネル取得エラー (${channelId}): ${msg}`);
    }
  }

  if (channels.length === 0) {
    opts.log?.('日誌: 新しい発言なし');
    return null;
  }

  return {
    kind: 'journal',
    reason: opts.reason,
    date,
    since,
    channels,
  };
}

/**
 * 日誌依頼を生成し、`enqueue` が成功したら `journal-last.json` の `at` を今に更新する。
 */
export async function collectAndEnqueueJournal(opts: {
  reason: JournalReason;
  stateDir: string;
  getConfig: () => BotConfig;
  fetchMessages: (channelId: string) => Promise<string>;
  getChannelName?: (channelId: string) => Promise<string | undefined>;
  enqueue: (item: JournalItem) => Promise<boolean> | boolean;
  now?: Date;
  log?: (msg: string) => void;
}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const item = await createJournalItem({
    reason: opts.reason,
    stateDir: opts.stateDir,
    getConfig: opts.getConfig,
    fetchMessages: opts.fetchMessages,
    getChannelName: opts.getChannelName,
    now,
    log: opts.log,
  });
  if (!item) {
    return false;
  }
  const ok = await opts.enqueue(item);
  if (ok) {
    saveJournalLastAt(opts.stateDir, now);
  }
  return ok;
}

/**
 * JST の指定時刻 (`HH:MM`) の次回実行日時を計算する（純粋関数）。
 * 今日のその時刻を過ぎていれば翌日の同時刻を返す。
 */
export function nextJournalRunAt(hhmm: string, now: Date = new Date()): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) {
    throw new Error(`Invalid journal time "${hhmm}": must be HH:MM`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid journal time "${hhmm}": must be 00:00-23:59`);
  }

  const todayJst = formatJstDate(now);
  const todayTarget = new Date(`${todayJst}T${hhmm}:00+09:00`);
  if (now.getTime() < todayTarget.getTime()) {
    return todayTarget;
  }
  return new Date(todayTarget.getTime() + DAY_MS);
}

/**
 * 予定時刻に対してタイマーが発火した時刻から、実行・スキップ・早すぎ判定を返す（純粋関数）。
 * PC スリープ等で遅れて復帰した場合、1 時間（maxDelayMs）以内なら `'run'`、超過なら `'skip'`。
 */
export function classifyJournalWakeup(
  scheduledAt: Date,
  firedAt: Date,
  maxDelayMs: number = DEFAULT_MAX_WAKEUP_DELAY_MS,
): 'run' | 'skip' | 'early' {
  const diff = firedAt.getTime() - scheduledAt.getTime();
  if (diff < -1000) {
    return 'early';
  }
  if (diff <= maxDelayMs) {
    return 'run';
  }
  return 'skip';
}

/**
 * 毎日 JST の指定時刻に日誌処理を呼び出すスケジューラを起動する。
 * setTimeout で毎回次回時刻を計算し直す方式。
 */
export function startDailyJournalScheduler(opts: {
  time: string;
  onTrigger: () => Promise<void>;
  log?: (msg: string) => void;
  now?: () => Date;
  maxDelayMs?: number;
}): { stop(): void } {
  const getNow = opts.now ?? (() => new Date());
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_WAKEUP_DELAY_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function scheduleNext(baseNow: Date): void {
    if (stopped) return;
    const scheduledAt = nextJournalRunAt(opts.time, baseNow);
    const delayMs = Math.max(0, scheduledAt.getTime() - getNow().getTime());

    timer = setTimeout(() => {
      void (async () => {
        if (stopped) return;
        const firedAt = getNow();
        const decision = classifyJournalWakeup(scheduledAt, firedAt, maxDelayMs);

        if (decision === 'early') {
          scheduleNext(firedAt);
          return;
        }

        if (decision === 'skip') {
          opts.log?.('日誌: 定時時刻から 1 時間以上経過したため本日はスキップします');
          scheduleNext(firedAt);
          return;
        }

        try {
          await opts.onTrigger();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts.log?.(`日誌スケジュール実行エラー: ${msg}`);
        }

        if (!stopped) {
          const nextBase = new Date(Math.max(getNow().getTime(), scheduledAt.getTime() + 1000));
          scheduleNext(nextBase);
        }
      })();
    }, delayMs);
  }

  scheduleNext(getNow());

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
