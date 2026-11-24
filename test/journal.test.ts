import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import {
  classifyJournalWakeup,
  collectAndEnqueueJournal,
  filterHistorySince,
  formatJournalBody,
  loadJournalLastAt,
  nextJournalRunAt,
  resolveJournalSince,
  saveJournalLastAt,
  type JournalItem,
} from '../src/journal.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'discord-agent-journal-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('filterHistorySince / journal-last.json', () => {
  test('since より新しい発言だけを抽出し、(no messages) や境界以下を除外する', () => {
    const sinceIso = '2026-11-24T01:00:00.000Z';
    const history = [
      '[2026-11-24T00:59:59.999Z] alice: older  (id: 1)',
      '[2026-11-24T01:00:00.000Z] bob: exact-same  (id: 2)',
      '[2026-11-24T01:00:00.001Z] carol: newer-1  (id: 3)',
      '[2026-11-24T02:30:00.000Z] me: newer-2  (id: 4)',
    ].join('\n');

    expect(filterHistorySince(history, sinceIso)).toBe(
      [
        '[2026-11-24T01:00:00.001Z] carol: newer-1  (id: 3)',
        '[2026-11-24T02:30:00.000Z] me: newer-2  (id: 4)',
      ].join('\n'),
    );
    expect(filterHistorySince('(no messages)', sinceIso)).toBe('');
  });

  test('journal-last.json が無ければ JST 当日 0 時を返し、保存後はその at を返す', () => {
    const stateDir = makeTempDir();
    expect(loadJournalLastAt(stateDir)).toBeUndefined();
    // 2026-11-24 00:00:00 JST = 2026-11-23T15:00:00.000Z
    expect(resolveJournalSince(stateDir, '2026-11-24')).toBe('2026-11-23T15:00:00.000Z');

    saveJournalLastAt(stateDir, '2026-11-24T12:34:56.000Z');
    expect(loadJournalLastAt(stateDir)).toBe('2026-11-24T12:34:56.000Z');
    expect(resolveJournalSince(stateDir, '2026-11-24')).toBe('2026-11-24T12:34:56.000Z');

    // 壊れた JSON ならフォールバック
    writeFileSync(join(stateDir, 'journal-last.json'), '{broken', 'utf8');
    expect(resolveJournalSince(stateDir, '2026-11-24')).toBe('2026-11-23T15:00:00.000Z');
  });
});

describe('collectAndEnqueueJournal', () => {
  test('since 以降の発言があるチャンネルだけを含めて依頼し、journal-last.json の at を更新する', async () => {
    const stateDir = makeTempDir();
    saveJournalLastAt(stateDir, '2026-11-24T03:00:00.000Z');

    const cfg = parseConfig({
      channels: {
        'ch-1': { requireMention: true },
        'ch-2': { requireMention: true },
        'ch-3': { requireMention: true },
      },
      patrolChannels: ['ch-1', 'ch-2'],
    });

    const histories: Record<string, string> = {
      'ch-1': [
        '[2026-11-24T02:00:00.000Z] alice: old  (id: 10)',
        '[2026-11-24T04:00:00.000Z] alice: new1  (id: 11)',
      ].join('\n'),
      'ch-2': '[2026-11-24T02:30:00.000Z] bob: only-old  (id: 12)',
      'ch-3': '[2026-11-24T05:00:00.000Z] carol: excluded-by-patrolChannels  (id: 13)',
    };

    const enqueued: JournalItem[] = [];
    const now = new Date('2026-11-24T14:55:00.000Z'); // JST 2026-11-24 23:55

    const ok = await collectAndEnqueueJournal({
      reason: 'daily',
      stateDir,
      getConfig: () => cfg,
      fetchMessages: async (id) => histories[id] ?? '(no messages)',
      enqueue: async (item) => {
        enqueued.push(item);
        return true;
      },
      now,
    });

    expect(ok).toBe(true);
    expect(enqueued).toEqual([
      {
        kind: 'journal',
        reason: 'daily',
        date: '2026-11-24',
        since: '2026-11-24T03:00:00.000Z',
        channels: [
          {
            chatId: 'ch-1',
            history: '[2026-11-24T04:00:00.000Z] alice: new1  (id: 11)',
          },
        ],
      },
    ]);

    const saved = JSON.parse(readFileSync(join(stateDir, 'journal-last.json'), 'utf8')) as {
      at: string;
    };
    expect(saved.at).toBe('2026-11-24T14:55:00.000Z');
  });

  test('全チャンネルで新しい発言が 0 件なら依頼せずログを出し、journal-last.json も更新しない', async () => {
    const stateDir = makeTempDir();
    const initialAt = '2026-11-24T03:00:00.000Z';
    saveJournalLastAt(stateDir, initialAt);

    const cfg = parseConfig({
      channels: {
        'ch-1': { requireMention: true },
        'ch-2': { requireMention: true },
      },
    });

    const logs: string[] = [];
    let enqueueCalls = 0;

    const ok = await collectAndEnqueueJournal({
      reason: 'shutdown',
      stateDir,
      getConfig: () => cfg,
      fetchMessages: async (id) =>
        id === 'ch-1' ? '[2026-11-24T02:59:00.000Z] alice: old  (id: 1)' : '(no messages)',
      enqueue: async () => {
        enqueueCalls += 1;
        return true;
      },
      now: new Date('2026-11-24T10:00:00.000Z'),
      log: (m) => logs.push(m),
    });

    expect(ok).toBe(false);
    expect(enqueueCalls).toBe(0);
    expect(logs).toContain('日誌: 新しい発言なし');
    expect(loadJournalLastAt(stateDir)).toBe(initialAt);
  });
});

describe('nextJournalRunAt / classifyJournalWakeup / formatJournalBody', () => {
  test('JST の指定時刻前なら当日、過ぎていれば翌日の同時刻を返す', () => {
    // 2026-11-24 23:00 JST = 2026-11-24T14:00:00.000Z
    const before = new Date('2026-11-24T14:00:00.000Z');
    expect(nextJournalRunAt('23:55', before).toISOString()).toBe('2026-11-24T14:55:00.000Z');

    // 2026-11-24 23:55 JST ちょうど・過ぎた直後は翌日 23:55 JST
    const exact = new Date('2026-11-24T14:55:00.000Z');
    expect(nextJournalRunAt('23:55', exact).toISOString()).toBe('2026-11-25T14:55:00.000Z');

    // 2026-11-25 00:10 JST = 2026-11-24T15:10:00.000Z -> 当日(11/25)の 23:55 JST
    const afterMidnightJst = new Date('2026-11-24T15:10:00.000Z');
    expect(nextJournalRunAt('23:55', afterMidnightJst).toISOString()).toBe(
      '2026-11-25T14:55:00.000Z',
    );
  });

  test('遅延 1 時間以内は run、1 時間超は skip、1 秒超早ければ early を返す', () => {
    const scheduled = new Date('2026-11-24T14:55:00.000Z');

    expect(classifyJournalWakeup(scheduled, new Date('2026-11-24T14:55:00.000Z'))).toBe('run');
    expect(classifyJournalWakeup(scheduled, new Date('2026-11-24T15:54:59.000Z'))).toBe('run');
    expect(classifyJournalWakeup(scheduled, new Date('2026-11-24T15:55:00.000Z'))).toBe('run');
    expect(classifyJournalWakeup(scheduled, new Date('2026-11-24T15:55:00.001Z'))).toBe('skip');
    expect(classifyJournalWakeup(scheduled, new Date('2026-11-24T14:54:58.000Z'))).toBe('early');
  });

  test('formatJournalBody が指定フォーマットどおりの文字列を返す', () => {
    const text = formatJournalBody({
      reason: 'shutdown',
      date: '2026-11-24',
      since: '2026-11-24T00:00:00.000Z', // JST 09:00
      channels: [
        { chatId: '100', history: '[2026-11-24T01:00:00.000Z] alice: hi  (id: 1)' },
        { chatId: '200', history: '[2026-11-24T02:00:00.000Z] bob: yo  (id: 2)' },
      ],
    });
    expect(text).toBe(
      [
        '=== journal ===',
        '理由: shutdown',
        '日付: 2026-11-24',
        '対象期間: 2026-11-24 09:00 JST 〜 今',
        '--- chat_id=100 ---',
        '[2026-11-24T01:00:00.000Z] alice: hi  (id: 1)',
        '--- chat_id=200 ---',
        '[2026-11-24T02:00:00.000Z] bob: yo  (id: 2)',
      ].join('\n'),
    );
  });
});

import { formatJournalBody as fmtJournal } from '../src/journal.ts';

describe('formatJournalBody のチャンネル名', () => {
  test('name があれば chat_id と併記し、無ければ ID だけ', () => {
    const body = fmtJournal({
      reason: 'daily',
      date: '2026-01-02',
      since: '2026-01-01T15:00:00.000Z',
      channels: [
        { chatId: '111', name: 'general', history: 'a' },
        { chatId: '222', history: 'b' },
      ],
    });
    expect(body).toContain('--- chat_id=111 name=#general ---');
    expect(body).toContain('--- chat_id=222 ---');
  });
});
