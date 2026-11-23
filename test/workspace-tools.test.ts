import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import type { DiscordTools } from '../src/discord.ts';
import {
  addPerson,
  appendNoteToPersonCsv,
  appendPersonToCsv,
  applyStateUpdate,
  escapeCsvField,
  notePerson,
  parseCsvRecords,
  setState,
} from '../src/workspace-tools.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'workspace-tools-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createStubTools(authorId: string): DiscordTools {
  return {
    async reply() {
      return '';
    },
    async react() {
      return '';
    },
    async editMessage() {
      return '';
    },
    async downloadAttachment() {
      return '';
    },
    async fetchMessages() {
      return '';
    },
    async listMembers() {
      return '';
    },
    async getMessageAuthor() {
      return { authorId, content: '切り替え' };
    },
  };
}

describe('applyStateUpdate / setState', () => {
  test('一致するトップレベル行だけを置換し、サブ行・他行・CRLF を保つ', () => {
    const input = [
      '# 現在の状態',
      '',
      '- ペルソナ: 丁寧（前回の値）',
      '  - 例外: 特定の相手には別ペルソナを使う',
      '  - ペルソナ: サブ行のダミー',
      '- 解説モード: オフ',
      '- 長さ(目安): 短め',
      '',
    ].join('\r\n');

    // 2026-08-25T16:30:00Z -> JST 2026-08-26 01:30
    const now = new Date('2026-08-25T16:30:00.000Z');
    const { nextContent, formattedValue } = applyStateUpdate(
      input,
      'ペルソナ',
      'カジュアル（理由あり）',
      now,
    );

    expect(formattedValue).toBe('カジュアル（理由あり）（Discord 指示 2026-08-26 01:30 JST）');
    expect(nextContent).toBe(
      [
        '# 現在の状態',
        '',
        '- ペルソナ: カジュアル（理由あり）（Discord 指示 2026-08-26 01:30 JST）',
        '  - 例外: 特定の相手には別ペルソナを使う',
        '  - ペルソナ: サブ行のダミー',
        '- 解説モード: オフ',
        '- 長さ(目安): 短め',
        '',
      ].join('\r\n'),
    );
  });

  test('LF 改行や末尾改行なしも元のまま保ち、括弧付きキーも置換できる', () => {
    const input = '# 現在の状態\n- 長さ(目安): 短め';
    const now = new Date('2026-11-20T08:05:00.000Z');
    const { nextContent } = applyStateUpdate(input, '長さ(目安)', '長め', now);
    expect(nextContent).toBe('# 現在の状態\n- 長さ(目安): 長め（Discord 指示 2026-11-20 17:05 JST）');
  });

  test('未知のキーやサブ行のみのキーはエラーになり新規作成しない', () => {
    const input = '- ペルソナ: 標準\r\n  - 例外: なし\r\n';
    expect(() => applyStateUpdate(input, '存在しないキー', 'オン')).toThrow(/見つかりません/);
    expect(() => applyStateUpdate(input, '例外', 'あり')).toThrow(/見つかりません/);
  });

  test('value の改行・空文字・200文字超過はエラー', () => {
    const input = '- 詳細モード: オフ\r\n';
    expect(() => applyStateUpdate(input, '詳細モード', 'オン\n改行')).toThrow(/改行/);
    expect(() => applyStateUpdate(input, '詳細モード', 'オン\r改行')).toThrow(/改行/);
    expect(() => applyStateUpdate(input, '詳細モード', '   ')).toThrow();
    expect(() => applyStateUpdate(input, '詳細モード', 'あ'.repeat(201))).toThrow(/200/);
    expect(() => applyStateUpdate(input, '詳細モード', 'あ'.repeat(200))).not.toThrow();
  });

  test('setState は権限のない送信者を拒否し、ファイルを書き換えない', async () => {
    const ws = makeTempDir();
    const stateFile = join(ws, '現在の状態.md');
    const initial = '# 現在の状態\r\n- 詳細モード: オフ\r\n';
    writeFileSync(stateFile, initial, 'utf8');

    const cfg = parseConfig({ modeAdmins: ['111111'] });
    await expect(
      setState(
        {
          tools: createStubTools('999999'),
          workspace: ws,
          getConfig: () => cfg,
        },
        { chat_id: 'c1', message_id: 'm1', key: '詳細モード', value: 'オン' },
      ),
    ).rejects.toThrow('切り替え権限がありません');

    expect(readFileSync(stateFile, 'utf8')).toBe(initial);
  });

  test('setState でキーがペルソナのときはファイル存在を確認する', async () => {
    const ws = makeTempDir();
    mkdirSync(join(ws, 'ペルソナ'), { recursive: true });
    writeFileSync(join(ws, 'ペルソナ', 'カスタム.md'), '# カスタム\n', 'utf8');
    writeFileSync(join(ws, '現在の状態.md'), '- ペルソナ: 標準\r\n', 'utf8');

    const cfg = parseConfig({ modeAdmins: ['111222333444555666'] });
    const tools = createStubTools('111222333444555666');

    await expect(
      setState(
        { tools, workspace: ws, getConfig: () => cfg },
        { chat_id: 'c1', message_id: 'm1', key: 'ペルソナ', value: '存在しないペルソナ' },
      ),
    ).rejects.toThrow(/ペルソナファイルが見つかりません/);

    const now = new Date('2026-11-20T00:00:00.000Z');
    const res = await setState(
      { tools, workspace: ws, getConfig: () => cfg, now },
      {
        chat_id: 'c1',
        message_id: 'm1',
        key: 'ペルソナ',
        value: 'カスタム（標準から切り替え）',
      },
    );
    expect(res).toBe('更新: ペルソナ: カスタム（標準から切り替え）（Discord 指示 2026-11-20 09:00 JST）');
    expect(readFileSync(join(ws, '現在の状態.md'), 'utf8')).toBe(
      '- ペルソナ: カスタム（標準から切り替え）（Discord 指示 2026-11-20 09:00 JST）\r\n',
    );
    // tmp ファイルが残っていないこと
    expect(readdirSync(ws).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('CSV パース・エスケープ・addPerson / notePerson', () => {
  test('parseCsvRecords はクォート内のカンマ・改行・"" エスケープを正しく扱う', () => {
    const raw =
      '名前,user_id,解説\r\n' +
      'alice,100,"1行目, カンマ入り\n2行目 ""引用"""\r\n' +
      '\r\n' +
      'bob,不明,通常行\r\n';
    const records = parseCsvRecords(raw);
    expect(records.length).toBe(4);
    expect(records[0]!.fields).toEqual(['名前', 'user_id', '解説']);
    expect(records[1]!.fields).toEqual(['alice', '100', '1行目, カンマ入り\n2行目 "引用"']);
    expect(records[2]!.isBlank).toBe(true);
    expect(records[3]!.fields).toEqual(['bob', '不明', '通常行']);
  });

  test('escapeCsvField はカンマ・ダブルクォート・改行を含む場合のみクォートする', () => {
    expect(escapeCsvField('通常テキスト')).toBe('通常テキスト');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('a"b')).toBe('"a""b"');
    expect(escapeCsvField('a\nb')).toBe('"a\nb"');
  });

  test('appendPersonToCsv は既存の改行コードと末尾改行有無に合わせて 1 行追加する', () => {
    const crlfWithTrailing = '名前,user_id,解説\r\nalice,100,最初の人\r\n';
    expect(
      appendPersonToCsv(crlfWithTrailing, {
        name: 'bob, jr',
        user_id: '200',
        description: '彼は "テスト" 好き\n2行目',
      }),
    ).toBe(
      '名前,user_id,解説\r\nalice,100,最初の人\r\n"bob, jr",200,"彼は ""テスト"" 好き\n2行目"\r\n',
    );

    const lfWithoutTrailing = '名前,user_id,解説\nalice,100,最初の人';
    expect(
      appendPersonToCsv(lfWithoutTrailing, {
        name: 'carol',
        user_id: '不明',
        description: '無印',
      }),
    ).toBe('名前,user_id,解説\nalice,100,最初の人\ncarol,不明,無印');
  });

  test('appendPersonToCsv は重複や文字数超過・不正 user_id を拒否する', () => {
    const csv =
      '名前,user_id,解説\r\n' +
      'alice,100,"複数行\n解説"\r\n' +
      'unknown_a,不明,ID不明1\r\n';

    expect(() =>
      appendPersonToCsv(csv, { name: '別名', user_id: '100', description: '重複' }),
    ).toThrow('既に登録済み: alice');

    // user_id が「不明」同士でも name が違えば追加でき、同じ name は拒否
    expect(() =>
      appendPersonToCsv(csv, { name: 'unknown_b', user_id: '不明', description: 'ID不明2' }),
    ).not.toThrow();
    expect(() =>
      appendPersonToCsv(csv, { name: 'unknown_a', user_id: '不明', description: '重複' }),
    ).toThrow('既に登録済み: unknown_a');

    expect(() =>
      appendPersonToCsv(csv, { name: 'x', user_id: 'abc', description: 'ok' }),
    ).toThrow(/user_id/);
    expect(() =>
      appendPersonToCsv(csv, { name: 'あ'.repeat(51), user_id: '300', description: 'ok' }),
    ).toThrow(/50/);
    expect(() =>
      appendPersonToCsv(csv, { name: 'ok', user_id: '300', description: 'あ'.repeat(401) }),
    ).toThrow(/400/);
  });

  test('appendNoteToPersonCsv は「。」の有無を判定して追記し、触らない行を元のまま保つ', () => {
    const untouchedRow = '"alice, 1",100,"元の""クォート""付き行"';
    const input = [
      '名前,user_id,解説',
      untouchedRow,
      '',
      'bob,200,語尾が句点なし',
      'carol,300,語尾が句点あり。',
      '',
    ].join('\r\n');

    const now = new Date('2026-11-20T16:00:00.000Z'); // JST 2026-11-21
    const res1 = appendNoteToPersonCsv(input, { user_id: '200', note: '新メモ, カンマ' }, now);
    expect(res1.name).toBe('bob');
    expect(res1.nextContent).toBe(
      [
        '名前,user_id,解説',
        untouchedRow,
        '',
        'bob,200,"語尾が句点なし。新メモ, カンマ（2026-11-21 追記）"',
        'carol,300,語尾が句点あり。',
        '',
      ].join('\r\n'),
    );

    const res2 = appendNoteToPersonCsv(res1.nextContent, { user_id: '300', note: '2回目' }, now);
    expect(res2.nextContent).toBe(
      [
        '名前,user_id,解説',
        untouchedRow,
        '',
        'bob,200,"語尾が句点なし。新メモ, カンマ（2026-11-21 追記）"',
        'carol,300,語尾が句点あり。2回目（2026-11-21 追記）',
        '',
      ].join('\r\n'),
    );
  });

  test('appendNoteToPersonCsv は該当なし・不正引数・改行・150文字超過を拒否する', () => {
    const csv = '名前,user_id,解説\r\nbob,200,説明\r\n';
    expect(() => appendNoteToPersonCsv(csv, { user_id: '999', note: 'x' })).toThrow(/見つかりません/);
    expect(() => appendNoteToPersonCsv(csv, { user_id: '不明', note: 'x' })).toThrow(/数字/);
    expect(() => appendNoteToPersonCsv(csv, { user_id: '200', note: 'a\nb' })).toThrow(/改行/);
    expect(() =>
      appendNoteToPersonCsv(csv, { user_id: '200', note: 'あ'.repeat(151) }),
    ).toThrow(/150/);
  });

  test('addPerson と notePerson が一時ディレクトリ上のファイルを原子的に読み書きする', async () => {
    const ws = makeTempDir();
    const ctxDir = join(ws, 'Context');
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(join(ctxDir, '人物一覧.csv'), '名前,user_id,解説\r\n', 'utf8');

    const addRes = await addPerson(
      { workspace: ws },
      { name: 'test_person', user_id: '555666', description: '初期解説' },
    );
    expect(addRes).toBe('追加: test_person (555666)');

    const noteRes = await notePerson(
      { workspace: ws, now: new Date('2026-11-20T05:00:00.000Z') },
      { user_id: '555666', note: '追記メモ' },
    );
    expect(noteRes).toBe('追記: test_person (555666)');

    expect(readFileSync(join(ctxDir, '人物一覧.csv'), 'utf8')).toBe(
      '名前,user_id,解説\r\ntest_person,555666,初期解説。追記メモ（2026-11-20 追記）\r\n',
    );
    expect(readdirSync(ctxDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
