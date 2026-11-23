import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, type BotConfig } from '../src/config.ts';
import type { DiscordTools } from '../src/discord.ts';
import { handleToolRequest, type ToolRequestContext } from '../src/tool-server.ts';

type RecordedCall = {
  method: keyof DiscordTools;
  args: unknown;
};

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tool-server-ws-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createFakeTools(overrides: Partial<DiscordTools> = {}): {
  tools: DiscordTools;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const tools: DiscordTools = {
    async reply(a) {
      calls.push({ method: 'reply', args: a });
      return 'sent (id: 1001)';
    },
    async react(a) {
      calls.push({ method: 'react', args: a });
      return 'reacted';
    },
    async editMessage(a) {
      calls.push({ method: 'editMessage', args: a });
      return 'edited (id: 1001)';
    },
    async downloadAttachment(a) {
      calls.push({ method: 'downloadAttachment', args: a });
      return 'message has no attachments';
    },
    async fetchMessages(a) {
      calls.push({ method: 'fetchMessages', args: a });
      return '(no messages)';
    },
    async listMembers(a) {
      calls.push({ method: 'listMembers', args: a });
      return 'Alice (alice)  id: 42';
    },
    async getMessageAuthor(chatId, messageId) {
      calls.push({ method: 'getMessageAuthor', args: { chatId, messageId } });
      return { authorId: '111222333444555666', content: 'mode change' };
    },
    ...overrides,
  };
  return { tools, calls };
}

const TEST_TOKEN = 'secret-test-token-0123456789abcdef';

function makeCtx(
  tools: DiscordTools,
  extra: { workspace?: string; config?: Partial<BotConfig> } = {},
): ToolRequestContext {
  const cfg = parseConfig(extra.config ?? {});
  return {
    tools,
    token: TEST_TOKEN,
    workspace: extra.workspace,
    getConfig: () => cfg,
  };
}

function makeRequest(
  path: string,
  opts: {
    method?: string;
    token?: string | null;
    body?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (opts.token !== null) {
    headers.authorization = `Bearer ${opts.token ?? TEST_TOKEN}`;
  }
  return new Request(`http://127.0.0.1:12345${path}`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body,
  });
}

describe('handleToolRequest', () => {
  test('Authorization ヘッダ欠如またはトークン不一致なら 401', async () => {
    const { tools } = createFakeTools();

    const missingRes = await handleToolRequest(
      makeRequest('/tool/reply', { token: null, body: JSON.stringify({ chat_id: '1', text: 'hi' }) }),
      { tools, token: TEST_TOKEN },
    );
    expect(missingRes.status).toBe(401);

    const wrongRes = await handleToolRequest(
      makeRequest('/tool/reply', {
        token: 'wrong-token',
        body: JSON.stringify({ chat_id: '1', text: 'hi' }),
      }),
      { tools, token: TEST_TOKEN },
    );
    expect(wrongRes.status).toBe(401);

    const sameLenWrongRes = await handleToolRequest(
      makeRequest('/tool/reply', {
        token: 'secret-test-token-0123456789abcde0',
        body: JSON.stringify({ chat_id: '1', text: 'hi' }),
      }),
      { tools, token: TEST_TOKEN },
    );
    expect(sameLenWrongRes.status).toBe(401);
  });

  test('未知のツール名や別メソッド・別パスなら 404', async () => {
    const { tools } = createFakeTools();

    const unknownTool = await handleToolRequest(
      makeRequest('/tool/nonexistent', { body: JSON.stringify({}) }),
      { tools, token: TEST_TOKEN },
    );
    expect(unknownTool.status).toBe(404);

    const wrongMethod = await handleToolRequest(
      makeRequest('/tool/reply', { method: 'GET' }),
      { tools, token: TEST_TOKEN },
    );
    expect(wrongMethod.status).toBe(404);

    const wrongPath = await handleToolRequest(
      makeRequest('/other/reply', { body: JSON.stringify({}) }),
      { tools, token: TEST_TOKEN },
    );
    expect(wrongPath.status).toBe(404);
  });

  test('不正な JSON または不正な引数なら 400 ({ ok: false, error })', async () => {
    const { tools, calls } = createFakeTools();

    const badJson = await handleToolRequest(
      makeRequest('/tool/reply', { body: '{invalid' }),
      { tools, token: TEST_TOKEN },
    );
    expect(badJson.status).toBe(400);
    const badJsonBody = (await badJson.json()) as { ok: boolean; error: string };
    expect(badJsonBody.ok).toBe(false);
    expect(typeof badJsonBody.error).toBe('string');

    const nonObject = await handleToolRequest(
      makeRequest('/tool/reply', { body: '[]' }),
      { tools, token: TEST_TOKEN },
    );
    expect(nonObject.status).toBe(400);
    const nonObjectBody = (await nonObject.json()) as { ok: boolean; error: string };
    expect(nonObjectBody.ok).toBe(false);

    const missingField = await handleToolRequest(
      makeRequest('/tool/reply', { body: JSON.stringify({ chat_id: '123' }) }),
      { tools, token: TEST_TOKEN },
    );
    expect(missingField.status).toBe(400);
    const missingBody = (await missingField.json()) as { ok: boolean; error: string };
    expect(missingBody.ok).toBe(false);

    const wrongType = await handleToolRequest(
      makeRequest('/tool/fetch_messages', {
        body: JSON.stringify({ channel: '123', limit: '20' }),
      }),
      { tools, token: TEST_TOKEN },
    );
    expect(wrongType.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test('正常な呼び出しは 200 ({ ok: true, result }) を返し引数をそのまま渡す', async () => {
    const { tools, calls } = createFakeTools();

    const res = await handleToolRequest(
      makeRequest('/tool/reply', {
        body: JSON.stringify({
          chat_id: '111',
          text: 'hello',
          reply_to: '222',
          files: ['C:/tmp/a.png'],
        }),
      }),
      { tools, token: TEST_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: 'sent (id: 1001)' });
    expect(calls).toEqual([
      {
        method: 'reply',
        args: {
          chat_id: '111',
          text: 'hello',
          reply_to: '222',
          files: ['C:/tmp/a.png'],
        },
      },
    ]);
  });

  test('list_members の user_id が DiscordTools.listMembers の memberId にマップされる', async () => {
    const { tools, calls } = createFakeTools();

    const res = await handleToolRequest(
      makeRequest('/tool/list_members', {
        body: JSON.stringify({
          channel: '999',
          user_id: '42',
          limit: 50,
        }),
      }),
      { tools, token: TEST_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: 'Alice (alice)  id: 42' });
    expect(calls).toEqual([
      {
        method: 'listMembers',
        args: {
          channel: '999',
          memberId: '42',
          limit: 50,
        },
      },
    ]);
  });

  test('ツール実行が例外を投げた場合は 200 で { ok: false, error } を返す', async () => {
    const { tools } = createFakeTools({
      async react() {
        throw new Error('channel 123 is not allowlisted');
      },
    });

    const res = await handleToolRequest(
      makeRequest('/tool/react', {
        body: JSON.stringify({
          chat_id: '123',
          message_id: '456',
          emoji: '👍',
        }),
      }),
      { tools, token: TEST_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'channel 123 is not allowlisted',
    });
  });

  test('set_state / add_person / note_person が HTTP 経由で動作する', async () => {
    const workspace = makeTempWorkspace();
    mkdirSync(join(workspace, 'ペルソナ'), { recursive: true });
    mkdirSync(join(workspace, 'Context'), { recursive: true });
    writeFileSync(join(workspace, 'ペルソナ', '標準.md'), '# 標準\n', 'utf8');
    writeFileSync(
      join(workspace, '現在の状態.md'),
      '# 現在の状態\r\n\r\n- ペルソナ: デフォルト\r\n- モードA: オフ\r\n',
      'utf8',
    );
    writeFileSync(join(workspace, 'Context', '人物一覧.csv'), '名前,user_id,解説\r\n', 'utf8');

    const { tools } = createFakeTools();
    const ctx = makeCtx(tools, { workspace, config: { modeAdmins: ['111222333444555666'] } });

    const stateRes = await handleToolRequest(
      makeRequest('/tool/set_state', {
        body: JSON.stringify({
          chat_id: '111',
          message_id: '222',
          key: 'ペルソナ',
          value: '標準',
        }),
      }),
      ctx,
    );
    expect(stateRes.status).toBe(200);
    const stateBody = (await stateRes.json()) as { ok: boolean; result: string };
    expect(stateBody.ok).toBe(true);
    expect(stateBody.result).toMatch(/^更新: ペルソナ: 標準（Discord 指示 \d{4}-\d{2}-\d{2} \d{2}:\d{2} JST）$/);

    const addRes = await handleToolRequest(
      makeRequest('/tool/add_person', {
        body: JSON.stringify({
          name: 'bob',
          user_id: '999888777',
          description: 'テスト人物',
        }),
      }),
      ctx,
    );
    expect(addRes.status).toBe(200);
    expect(await addRes.json()).toEqual({ ok: true, result: '追加: bob (999888777)' });

    const noteRes = await handleToolRequest(
      makeRequest('/tool/note_person', {
        body: JSON.stringify({
          user_id: '999888777',
          note: '補足情報',
        }),
      }),
      ctx,
    );
    expect(noteRes.status).toBe(200);
    expect(await noteRes.json()).toEqual({ ok: true, result: '追記: bob (999888777)' });

    const csv = readFileSync(join(workspace, 'Context', '人物一覧.csv'), 'utf8');
    expect(csv).toMatch(/^名前,user_id,解説\r\nbob,999888777,テスト人物。補足情報（\d{4}-\d{2}-\d{2} 追記）\r\n$/);
  });

  test('set_state の引数不足や workspace 未設定時はエラーを返す', async () => {
    const { tools } = createFakeTools();
    const badArgs = await handleToolRequest(
      makeRequest('/tool/set_state', { body: JSON.stringify({ chat_id: '1' }) }),
      makeCtx(tools),
    );
    expect(badArgs.status).toBe(400);

    const noWs = await handleToolRequest(
      makeRequest('/tool/add_person', {
        body: JSON.stringify({ name: 'a', user_id: '123', description: 'b' }),
      }),
      { tools, token: TEST_TOKEN },
    );
    expect(noWs.status).toBe(200);
    expect(await noWs.json()).toEqual({
      ok: false,
      error: 'workspace が設定されていません',
    });
  });
});
