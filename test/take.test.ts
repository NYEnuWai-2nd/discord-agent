import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPendingPayload, takePendingOnce } from '../scripts/take.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'discord-agent-take-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('take.ts', () => {
  test('formatPendingPayload が journal ペイロードを === journal === 形式で整形する', () => {
    const out = formatPendingPayload({
      kind: 'journal',
      reason: 'daily',
      date: '2026-11-24',
      since: '2026-11-23T15:00:00.000Z',
      channels: [
        { chatId: '111', history: '[2026-11-24T03:00:00.000Z] alice: hello  (id: 1)' },
      ],
    });
    expect(out).toBe(
      [
        '=== journal ===',
        '理由: daily',
        '日付: 2026-11-24',
        '対象期間: 2026-11-24 00:00 JST 〜 今',
        '--- chat_id=111 ---',
        '[2026-11-24T03:00:00.000Z] alice: hello  (id: 1)',
      ].join('\n'),
    );
  });

  test('takePendingOnce が *-journal.json を taken へ移して表示する', () => {
    const base = makeTempDir();
    const pendingDir = join(base, 'pending');
    const takenDir = join(base, 'taken');
    mkdirSync(pendingDir, { recursive: true });

    const fileName = '1795500000000-journal.json';
    writeFileSync(
      join(pendingDir, fileName),
      JSON.stringify({
        kind: 'journal',
        reason: 'daily',
        date: '2026-11-24',
        since: '2026-11-23T15:00:00.000Z',
        channels: [{ chatId: '222', history: '[2026-11-24T04:00:00.000Z] bob: ok  (id: 2)' }],
      }),
      'utf8',
    );

    const lines: string[] = [];
    const ok = takePendingOnce(pendingDir, takenDir, (s) => lines.push(s));

    expect(ok).toBe(true);
    expect(existsSync(join(pendingDir, fileName))).toBe(false);
    expect(existsSync(join(takenDir, fileName))).toBe(true);
    expect(lines[0]).toBe('残り: 0 件');
    expect(lines[1]).toContain('=== journal ===');
    expect(lines[1]).toContain('理由: daily');
    expect(lines[1]).toContain('--- chat_id=222 ---');
  });
});
