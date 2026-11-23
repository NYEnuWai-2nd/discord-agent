import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELP_TEXT, parseToolArgs } from '../scripts/tool.ts';

describe('parseToolArgs', () => {
  test('先頭の位置引数をツール名にし、ID などの文字列引数は文字列のまま保持する', () => {
    const parsed = parseToolArgs([
      'reply',
      '--chat_id',
      '1234567890123456789',
      '--reply_to',
      '9876543210987654321',
      '--text',
      'こんにちは',
    ]);

    expect(parsed).toEqual({
      name: 'reply',
      args: {
        chat_id: '1234567890123456789',
        reply_to: '9876543210987654321',
        text: 'こんにちは',
      },
    });
    expect(typeof parsed.args.chat_id).toBe('string');
    expect(typeof parsed.args.reply_to).toBe('string');
  });

  test('--files を複数回指定すると文字列配列にまとまる', () => {
    const single = parseToolArgs([
      'reply',
      '--chat_id',
      '1',
      '--text',
      'one',
      '--files',
      'C:/tmp/a.png',
    ]);
    expect(single.args.files).toEqual(['C:/tmp/a.png']);

    const multi = parseToolArgs([
      'reply',
      '--chat_id',
      '1',
      '--text',
      'two',
      '--files',
      'C:/tmp/a.png',
      '--files',
      'C:/tmp/b.png',
    ]);
    expect(multi.args.files).toEqual(['C:/tmp/a.png', 'C:/tmp/b.png']);
  });

  test('--limit は数値に変換され、数値以外なら例外を投げる', () => {
    const ok = parseToolArgs(['fetch_messages', '--channel', '123', '--limit', '50']);
    expect(ok.args.limit).toBe(50);
    expect(typeof ok.args.limit).toBe('number');

    expect(() => parseToolArgs(['fetch_messages', '--channel', '123', '--limit', 'abc'])).toThrow();
    expect(() => parseToolArgs(['fetch_messages', '--channel', '123', '--limit', ''])).toThrow();
    expect(() => parseToolArgs(['fetch_messages', '--channel', '123', '--limit', 'NaN'])).toThrow();
    expect(() =>
      parseToolArgs(['fetch_messages', '--channel', '123', '--limit', 'Infinity']),
    ).toThrow();
  });

  test('--text-file は UTF-8 ファイルから本文を読み込む', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-cli-test-'));
    try {
      const filePath = join(dir, 'msg.txt');
      writeFileSync(filePath, '1行目\n"引用"を含む2行目', 'utf8');

      const parsed = parseToolArgs(['reply', '--chat_id', '100', '--text-file', filePath]);
      expect(parsed).toEqual({
        name: 'reply',
        args: {
          chat_id: '100',
          text: '1行目\n"引用"を含む2行目',
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('未知のフラグは文字列のまま通し、必須値やツール名欠如は例外を投げる', () => {
    const parsed = parseToolArgs(['list_members', '--channel', '123', '--extra', '456']);
    expect(parsed.args.extra).toBe('456');

    expect(() => parseToolArgs([])).toThrow();
    expect(() => parseToolArgs(['reply', '--text'])).toThrow();
  });

  test('新規 3 ツールの引数パースと HELP_TEXT 記載', () => {
    const stateArgs = parseToolArgs([
      'set_state',
      '--chat_id',
      '111',
      '--message_id',
      '222',
      '--key',
      'ペルソナ',
      '--value',
      '標準',
    ]);
    expect(stateArgs).toEqual({
      name: 'set_state',
      args: { chat_id: '111', message_id: '222', key: 'ペルソナ', value: '標準' },
    });

    const addArgs = parseToolArgs([
      'add_person',
      '--name',
      'alice',
      '--user_id',
      '123456789012345678',
      '--description',
      '常連',
    ]);
    expect(addArgs.args.user_id).toBe('123456789012345678');

    expect(HELP_TEXT).toContain('set_state');
    expect(HELP_TEXT).toContain('add_person');
    expect(HELP_TEXT).toContain('note_person');
  });
});
