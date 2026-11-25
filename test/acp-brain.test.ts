import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAcpBrain, formatAcpPrompt } from '../src/acp-brain.ts';
import { loadAcpModel, loadAcpSessionId, saveAcpModel } from '../src/acp-client.ts';

const FIXTURE_PATH = path.resolve(import.meta.dir, 'fixtures/fake-acp-agent.ts').replace(/\\/g, '/');

const tempDirs: string[] = [];

function makeTempDir(prefix = 'discord-agent-brain-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type FakeLogEntry = {
  kind: string;
  sessionId?: string;
  msg: {
    method?: string;
    params?: {
      prompt?: Array<{ text?: string }>;
    };
  };
};

function readFakeLog(logFile: string): FakeLogEntry[] {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as FakeLogEntry);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error('waitFor timed out');
}

afterEach(() => {
  delete process.env.FAKE_ACP_LOG_FILE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('formatAcpPrompt', () => {
  test('inbound と patrol と journal を整形し、初回のみ新案内・状態ファイルを付ける', () => {
    const inboundWithIntro = formatAcpPrompt(
      { kind: 'inbound', inbound: '<channel>hi</channel>', history: '[t] a: hi' },
      'C:/repo/GEMINI_BRAIN.md',
      true,
      'ペルソナ: テスト\n',
    );
    expect(inboundWithIntro).toStartWith(
      '最初に C:/repo/GEMINI_BRAIN.md を読み、ACP モードの節に従うこと。現在の状態は各発言の先頭に添付されるので、現在の状態.md を読み直す必要はない。',
    );
    expect(inboundWithIntro).toContain(
      '=== 現在の状態（bot が添付。読み直し不要） ===\nペルソナ: テスト',
    );
    expect(inboundWithIntro).toContain('=== inbound ===\n<channel>hi</channel>');
    expect(inboundWithIntro).toContain('=== history（古い順。me は bot 自身） ===\n[t] a: hi');
    expect(inboundWithIntro).toEndWith(
      '指示書の手順に従って判断し、返すなら tool.ts で返す。返さないなら何もしない。この会話への最終回答は 1 行でよい。',
    );

    const patrolWithoutIntro = formatAcpPrompt(
      {
        kind: 'patrol',
        channels: [
          { chatId: '111', history: 'line1' },
          { chatId: '222', history: 'line2' },
        ],
      },
      'C:/repo/GEMINI_BRAIN.md',
      false,
    );
    expect(patrolWithoutIntro.startsWith('=== patrol ===')).toBe(true);
    expect(patrolWithoutIntro).toContain('--- chat_id=111 ---\nline1');
    expect(patrolWithoutIntro).toContain('--- chat_id=222 ---\nline2');

    const journalPrompt = formatAcpPrompt(
      {
        kind: 'journal',
        reason: 'daily',
        date: '2026-11-24',
        since: '2026-11-23T15:00:00.000Z',
        channels: [{ chatId: 'ch1', history: '[2026-11-24T01:00:00.000Z] alice: hello  (id: 1)' }],
      },
      'C:/repo/GEMINI_BRAIN.md',
      false,
    );
    expect(journalPrompt).toBe(
      [
        '=== journal ===',
        '理由: daily',
        '日付: 2026-11-24',
        '対象期間: 2026-11-24 00:00 JST 〜 今',
        '--- chat_id=ch1 ---',
        '[2026-11-24T01:00:00.000Z] alice: hello  (id: 1)',
        '',
        '指示書の『日誌』の節に従って要約し、tool.ts write_journal で書く。Discord には何も送らない。最終回答は 1 行でよい。',
      ].join('\n'),
    );
  });

  test('複数 inbound まとめは番号付きになり、連続する同一 chat_id は最後の件にだけ history を付ける', () => {
    const batched = formatAcpPrompt(
      [
        {
          kind: 'inbound',
          chatId: 'chA',
          inbound: '<channel chat_id="chA" message_id="1">m1</channel>',
          history: 'hist-A1',
        },
        {
          kind: 'inbound',
          chatId: 'chA',
          inbound: '<channel chat_id="chA" message_id="2">m2</channel>',
          history: 'hist-A2',
        },
        {
          kind: 'inbound',
          inbound: '<channel chat_id="chB" message_id="3">m3</channel>',
          history: 'hist-B1',
        },
      ],
      'C:/repo/GEMINI_BRAIN.md',
      false,
      'ペルソナ: 標準\n',
    );
    expect(batched).toBe(
      [
        '=== 現在の状態（bot が添付。読み直し不要） ===',
        'ペルソナ: 標準',
        '',
        '=== inbound 1/3 ===',
        '<channel chat_id="chA" message_id="1">m1</channel>',
        '=== inbound 2/3 ===',
        '<channel chat_id="chA" message_id="2">m2</channel>',
        '=== history（古い順。me は bot 自身） ===',
        'hist-A2',
        '=== inbound 3/3 ===',
        '<channel chat_id="chB" message_id="3">m3</channel>',
        '=== history（古い順。me は bot 自身） ===',
        'hist-B1',
        '',
        '上の各メッセージについて、指示書の手順に従ってそれぞれ判断し、返すものは tool.ts で個別に（各 message_id を --reply_to に付けて）返す。返さないものには何もしない。最終回答は 1 行でよい。',
      ].join('\n'),
    );
    expect(batched).not.toContain('hist-A1');
  });
});

describe('createAcpBrain', () => {
  test('直列に prompt を処理し、初回のみ案内を付け、毎回 onTurnEnd を呼ぶ', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;

    let turnEnds = 0;
    const brain = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      log: () => {},
      onTurnEnd: () => {
        turnEnds += 1;
      },
    });

    try {
      brain.enqueue({ kind: 'inbound', inbound: 'msg-1', history: 'h1' });
      await waitFor(() => turnEnds === 1);

      brain.enqueue({ kind: 'inbound', inbound: 'msg-2 TRIGGER_DELAY:120', history: 'h2' });
      await waitFor(() =>
        readFakeLog(logFile).some(
          (e) =>
            e.kind === 'received' &&
            e.msg.method === 'session/prompt' &&
            (e.msg.params?.prompt?.[0]?.text ?? '').includes('msg-2'),
        ),
      );
      brain.enqueue({ kind: 'patrol', channels: [{ chatId: 'ch1', history: 'h3' }] });
      expect(brain.hasPendingPatrol()).toBe(true);

      await waitFor(() => turnEnds === 3);

      expect(brain.hasPendingPatrol()).toBe(false);

      const prompts = readFakeLog(logFile)
        .filter((e) => e.kind === 'received' && e.msg.method === 'session/prompt')
        .map((e) => e.msg.params?.prompt?.[0]?.text ?? '');

      expect(prompts.length).toBe(3);
      expect(prompts[0]).toContain(
        '最初に C:/repo/GEMINI_BRAIN.md を読み、ACP モードの節に従うこと。現在の状態は各発言の先頭に添付されるので、現在の状態.md を読み直す必要はない。',
      );
      expect(prompts[0]).toContain('msg-1');
      expect(prompts[1]).not.toContain('最初に C:/repo/GEMINI_BRAIN.md を読み');
      expect(prompts[1]).toContain('msg-2');
      expect(prompts[2]).not.toContain('最初に C:/repo/GEMINI_BRAIN.md を読み');
      expect(prompts[2]).toContain('=== patrol ===');
    } finally {
      await brain.stop();
    }
  });

  test('warmup 指定時は新規セッション直後に準備ターンを送り、最初の件には案内を付けない', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;
    const logs: string[] = [];
    let turnEnds = 0;
    const brain = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      warmup: true,
      log: (m) => logs.push(m),
      onTurnEnd: () => {
        turnEnds += 1;
      },
    });
    try {
      await waitFor(() => logs.some((m) => m.startsWith('ACP 準備完了')));
      brain.enqueue({ kind: 'inbound', inbound: 'msg-1', history: 'h1' });
      await waitFor(() => turnEnds === 1);
      const prompts = readFakeLog(logFile)
        .filter((e) => e.kind === 'received' && e.msg.method === 'session/prompt')
        .map((e) => e.msg.params?.prompt?.[0]?.text ?? '');
      expect(prompts.length).toBe(2);
      expect(prompts[0]).toContain('準備: まず C:/repo/GEMINI_BRAIN.md を読み');
      expect(prompts[1]).toContain('msg-1');
      expect(prompts[1]).not.toContain('最初に C:/repo/GEMINI_BRAIN.md を読み');
    } finally {
      await brain.stop();
    }
  });

  test('maxTurns 到達でセッションを破棄して新規作成する', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;

    let turnEnds = 0;
    const brain = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      maxTurns: 2,
      log: () => {},
      onTurnEnd: () => {
        turnEnds += 1;
      },
    });

    try {
      brain.enqueue({ kind: 'inbound', inbound: 'turn-1', history: '' });
      await waitFor(() => turnEnds === 1);
      brain.enqueue({ kind: 'inbound', inbound: 'turn-2', history: '' });
      await waitFor(() => turnEnds === 2);

      const firstSessionId = loadAcpSessionId(stateDir);

      brain.enqueue({ kind: 'inbound', inbound: 'turn-3', history: '' });
      await waitFor(() => turnEnds === 3);

      const entries = readFakeLog(logFile);
      const sessionNewCount = entries.filter(
        (e) => e.kind === 'received' && e.msg.method === 'session/new',
      ).length;
      expect(sessionNewCount).toBe(2);

      const promptEntries = entries.filter(
        (e) => e.kind === 'received' && e.msg.method === 'session/prompt',
      );
      expect(promptEntries.length).toBe(3);
      expect(promptEntries[0]!.sessionId).toBe(promptEntries[1]!.sessionId);
      expect(promptEntries[2]!.sessionId).not.toBe(promptEntries[0]!.sessionId);
      expect(promptEntries[2]!.msg.params?.prompt?.[0]?.text).toContain(
        '最初に C:/repo/GEMINI_BRAIN.md を読み',
      );
      expect(loadAcpSessionId(stateDir)).not.toBe(firstSessionId);
    } finally {
      await brain.stop();
    }
  });

  test('子プロセスが落ちたら再起動し、キュー上限超過時は古い順に捨てる', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;

    let turnEnds = 0;
    const logs: string[] = [];
    const brain = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      restartDelaysMs: [50, 100],
      maxQueueSize: 3,
      log: (m) => logs.push(m),
      onTurnEnd: () => {
        turnEnds += 1;
      },
    });

    try {
      // 1 件目で意図的にクラッシュさせる
      brain.enqueue({ kind: 'inbound', inbound: 'TRIGGER_CRASH', history: '' });
      // クラッシュ直後の再起動待ち中に 4 件積む（上限 3 なので最古の drop-me が捨てられ、残り 3 件が 1 ターンにまとまる）
      await waitFor(() => turnEnds === 1);
      brain.enqueue({ kind: 'inbound', inbound: 'drop-me', history: '' });
      brain.enqueue({ kind: 'inbound', inbound: 'keep-1', history: '' });
      brain.enqueue({ kind: 'inbound', inbound: 'keep-2', history: '' });
      brain.enqueue({ kind: 'inbound', inbound: 'keep-3', history: '' });

      await waitFor(() => turnEnds === 2);

      const promptTexts = readFakeLog(logFile)
        .filter((e) => e.kind === 'received' && e.msg.method === 'session/prompt')
        .map((e) => e.msg.params?.prompt?.[0]?.text ?? '');

      expect(promptTexts.some((t) => t.includes('drop-me'))).toBe(false);
      expect(promptTexts.some((t) => t.includes('keep-1'))).toBe(true);
      expect(promptTexts.some((t) => t.includes('keep-2'))).toBe(true);
      expect(promptTexts.some((t) => t.includes('keep-3'))).toBe(true);
      expect(logs.some((l) => l.includes('キュー上限'))).toBe(true);
    } finally {
      await brain.stop();
    }
  });

  test('requestModel は待機中即適用・不正 ID 拒否・処理中はターン終了後に適用し acp-model.json に保存する', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;

    let turnEnds = 0;
    const brain = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      model: 'model-a',
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      log: () => {},
      onTurnEnd: () => {
        turnEnds += 1;
      },
    });

    try {
      // 未起動時は env 値・空 available を返す
      expect(brain.getModels()).toEqual({ current: 'model-a', available: [] });

      // 起動完了を待つ
      await waitFor(() => brain.getModels().available.length > 0);
      expect(brain.getModels()).toEqual({
        current: 'model-a',
        available: ['model-a', 'model-b'],
      });

      // 不正なモデル ID は拒否される
      await expect(brain.requestModel('nonexistent-model')).rejects.toThrow(
        /使えないモデル: nonexistent-model。使えるもの: model-a, model-b/,
      );

      // 待機中は即座に適用され、acp-model.json に保存される
      const idleMsg = await brain.requestModel('model-b');
      expect(idleMsg).toContain('model-b');
      expect(brain.getModels().current).toBe('model-b');
      expect(loadAcpModel(stateDir)).toBe('model-b');

      // ターン処理中の切り替えはターン終了後（次の prompt より前）に適用される
      const setModelCountBeforeTurn1 = readFakeLog(logFile).filter(
        (e) => e.kind === 'received' && e.msg.method === 'session/set_model',
      ).length;

      brain.enqueue({ kind: 'inbound', inbound: 'turn-1 TRIGGER_DELAY:200', history: '' });
      await waitFor(() =>
        readFakeLog(logFile).some(
          (e) =>
            e.kind === 'received' &&
            e.msg.method === 'session/prompt' &&
            (e.msg.params?.prompt?.[0]?.text ?? '').includes('turn-1'),
        ),
      );

      const inTurnMsg = await brain.requestModel('model-a');
      expect(inTurnMsg).toContain('model-a');

      // まだターン 1 処理中なので新たな session/set_model は送られていない
      const setModelCountDuringTurn1 = readFakeLog(logFile).filter(
        (e) => e.kind === 'received' && e.msg.method === 'session/set_model',
      ).length;
      expect(setModelCountDuringTurn1).toBe(setModelCountBeforeTurn1);

      brain.enqueue({ kind: 'inbound', inbound: 'turn-2', history: '' });
      await waitFor(() => turnEnds === 2);

      // 順序確認: turn-1 prompt -> model-a への set_model -> turn-2 prompt
      const methods = readFakeLog(logFile)
        .filter(
          (e) =>
            e.kind === 'received' &&
            (e.msg.method === 'session/prompt' || e.msg.method === 'session/set_model'),
        )
        .map((e) => ({
          method: e.msg.method,
          modelId: (e.msg.params as Record<string, unknown> | undefined)?.modelId,
          text: e.msg.params?.prompt?.[0]?.text ?? '',
        }));

      const turn1Idx = methods.findIndex((m) => m.method === 'session/prompt' && m.text.includes('turn-1'));
      const switchIdx = methods.findIndex(
        (m, i) => i > turn1Idx && m.method === 'session/set_model' && m.modelId === 'model-a',
      );
      const turn2Idx = methods.findIndex((m) => m.method === 'session/prompt' && m.text.includes('turn-2'));

      expect(turn1Idx).toBeGreaterThanOrEqual(0);
      expect(switchIdx).toBeGreaterThan(turn1Idx);
      expect(turn2Idx).toBeGreaterThan(switchIdx);
      expect(brain.getModels().current).toBe('model-a');
      expect(loadAcpModel(stateDir)).toBe('model-a');
    } finally {
      await brain.stop();
    }
  });

  test('保存済み acp-model.json は maxTurns 再作成・クラッシュ再起動・新規起動で BOT_ACP_MODEL より優先される', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;

    saveAcpModel(stateDir, 'model-b');

    let turnEnds = 0;
    const brain1 = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      model: 'model-a', // env 値より acp-model.json の model-b が優先されるべき
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      maxTurns: 1,
      restartDelaysMs: [30],
      log: () => {},
      onTurnEnd: () => {
        turnEnds += 1;
      },
    });

    try {
      expect(brain1.getModels()).toEqual({ current: 'model-b', available: [] });

      // 1 ターン目で maxTurns=1 に達し、次のターンでセッション作り直しになる
      brain1.enqueue({ kind: 'inbound', inbound: 'turn-1', history: '' });
      await waitFor(() => turnEnds === 1);

      brain1.enqueue({ kind: 'inbound', inbound: 'TRIGGER_CRASH', history: '' });
      await waitFor(() => turnEnds === 2);

      // クラッシュ後の再起動セッションでターン 3 を処理する
      brain1.enqueue({ kind: 'inbound', inbound: 'turn-3', history: '' });
      await waitFor(() => turnEnds === 3);

      const setModels = readFakeLog(logFile)
        .filter((e) => e.kind === 'received' && e.msg.method === 'session/set_model')
        .map((e) => (e.msg.params as Record<string, unknown> | undefined)?.modelId);

      // 初回起動・maxTurns 再作成・クラッシュ再起動のすべてで model-b が適用されている
      expect(setModels.length).toBeGreaterThanOrEqual(3);
      expect(setModels.every((m) => m === 'model-b')).toBe(true);
    } finally {
      await brain1.stop();
    }
  });

  test('close は以後の enqueue を無視し、drain は処理完了まで待って true・タイムアウトで false を返す', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;

    let turnEnds = 0;
    const brain = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      log: () => {},
      onTurnEnd: () => {
        turnEnds += 1;
      },
    });

    try {
      // アイドル状態なら即 true
      expect(await brain.drain(100)).toBe(true);

      brain.enqueue({ kind: 'inbound', inbound: 'slow-turn TRIGGER_DELAY:250', history: '' });
      // タイムアウトが短ければ false
      expect(await brain.drain(30)).toBe(false);

      // 完了まで待てば true
      expect(await brain.drain(5000)).toBe(true);
      expect(turnEnds).toBe(1);

      // close 後の enqueue は無視される
      brain.enqueue({ kind: 'inbound', inbound: 'accepted-before-close TRIGGER_DELAY:80', history: '' });
      brain.close();
      brain.enqueue({ kind: 'inbound', inbound: 'ignored-after-close', history: '' });

      expect(await brain.drain(5000)).toBe(true);
      expect(turnEnds).toBe(2);

      const prompts = readFakeLog(logFile)
        .filter((e) => e.kind === 'received' && e.msg.method === 'session/prompt')
        .map((e) => e.msg.params?.prompt?.[0]?.text ?? '');
      expect(prompts.some((t) => t.includes('accepted-before-close'))).toBe(true);
      expect(prompts.some((t) => t.includes('ignored-after-close'))).toBe(false);
    } finally {
      await brain.stop();
    }
  });

  test('優先順（inbound → journal → patrol）で処理し、inbound 待ち中は patrol を破棄する', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;

    let turnEnds = 0;
    const logs: string[] = [];
    const brain = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      log: (m) => logs.push(m),
      onTurnEnd: () => {
        turnEnds += 1;
      },
    });

    try {
      // 1. ターン 1 処理中に patrol → journal の順で積むと journal が先に処理される
      brain.enqueue({ kind: 'inbound', inbound: 'init-1 TRIGGER_DELAY:150', history: '' });
      await waitFor(() =>
        readFakeLog(logFile).some(
          (e) =>
            e.kind === 'received' &&
            e.msg.method === 'session/prompt' &&
            (e.msg.params?.prompt?.[0]?.text ?? '').includes('init-1'),
        ),
      );
      brain.enqueue({ kind: 'patrol', channels: [{ chatId: 'p1', history: 'patrol-1' }] });
      brain.enqueue({
        kind: 'journal',
        reason: 'daily',
        date: '2026-11-24',
        since: '2026-11-23T15:00:00.000Z',
        channels: [{ chatId: 'j1', history: '[2026-11-24T01:00:00.000Z] alice: j1  (id: 1)' }],
      });
      await waitFor(() => turnEnds === 3);

      // 2. ターン 4 処理中に patrol → inbound → patrol → journal の順で積む:
      //    inbound 到着時に既存の patrol が破棄され、inbound 待ち中の patrol も破棄され、inbound → journal の順で処理される
      brain.enqueue({ kind: 'inbound', inbound: 'init-2 TRIGGER_DELAY:150', history: '' });
      await waitFor(() =>
        readFakeLog(logFile).some(
          (e) =>
            e.kind === 'received' &&
            e.msg.method === 'session/prompt' &&
            (e.msg.params?.prompt?.[0]?.text ?? '').includes('init-2'),
        ),
      );
      brain.enqueue({ kind: 'patrol', channels: [{ chatId: 'p2', history: 'patrol-dropped-1' }] });
      expect(brain.hasPendingPatrol()).toBe(true);
      brain.enqueue({ kind: 'inbound', inbound: 'urgent-mention', history: 'hu' });
      expect(brain.hasPendingPatrol()).toBe(false);
      brain.enqueue({ kind: 'patrol', channels: [{ chatId: 'p3', history: 'patrol-dropped-2' }] });
      expect(brain.hasPendingPatrol()).toBe(false);
      brain.enqueue({
        kind: 'journal',
        reason: 'shutdown',
        date: '2026-11-24',
        since: '2026-11-23T15:00:00.000Z',
        channels: [{ chatId: 'j2', history: '[2026-11-24T02:00:00.000Z] bob: j2  (id: 2)' }],
      });

      await waitFor(() => turnEnds === 6);

      const prompts = readFakeLog(logFile)
        .filter((e) => e.kind === 'received' && e.msg.method === 'session/prompt')
        .map((e) => e.msg.params?.prompt?.[0]?.text ?? '');

      expect(prompts.length).toBe(6);
      expect(prompts[1]).toContain('=== journal ===');
      expect(prompts[2]).toContain('=== patrol ===');
      expect(prompts[4]).toContain('urgent-mention');
      expect(prompts[5]).toContain('=== journal ===');
      expect(prompts.some((t) => t.includes('patrol-dropped-1'))).toBe(false);
      expect(prompts.some((t) => t.includes('patrol-dropped-2'))).toBe(false);
      expect(logs.filter((l) => l === '巡回: メンション待ちのため破棄').length).toBe(2);
    } finally {
      await brain.stop();
    }
  });

  test('複数 inbound は最大 5 件まで 1 ターンにまとめ、maxTurns も 1 ターンとして数える', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;

    let turnEnds = 0;
    const logs: string[] = [];
    const brain = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      maxTurns: 3,
      log: (m) => logs.push(m),
      onTurnEnd: () => {
        turnEnds += 1;
      },
    });

    try {
      brain.enqueue({ kind: 'inbound', inbound: 'turn-1 TRIGGER_DELAY:150', history: '' });
      await waitFor(() =>
        readFakeLog(logFile).some(
          (e) =>
            e.kind === 'received' &&
            e.msg.method === 'session/prompt' &&
            (e.msg.params?.prompt?.[0]?.text ?? '').includes('turn-1'),
        ),
      );

      // 6 件積む: 先頭 5 件が 1 ターンにまとまり、6 件目は次ターンになる
      brain.enqueue({
        kind: 'inbound',
        chatId: 'chA',
        inbound: '<channel chat_id="chA" message_id="1">b1</channel>',
        history: 'hist-1',
      });
      brain.enqueue({
        kind: 'inbound',
        chatId: 'chA',
        inbound: '<channel chat_id="chA" message_id="2">b2</channel>',
        history: 'hist-2',
      });
      brain.enqueue({
        kind: 'inbound',
        chatId: 'chA',
        inbound: '<channel chat_id="chA" message_id="3">b3</channel>',
        history: 'hist-3',
      });
      brain.enqueue({
        kind: 'inbound',
        chatId: 'chB',
        inbound: '<channel chat_id="chB" message_id="4">b4</channel>',
        history: 'hist-4',
      });
      brain.enqueue({
        kind: 'inbound',
        chatId: 'chA',
        inbound: '<channel chat_id="chA" message_id="5">b5</channel>',
        history: 'hist-5',
      });
      brain.enqueue({
        kind: 'inbound',
        chatId: 'chC',
        inbound: '<channel chat_id="chC" message_id="6">b6</channel>',
        history: 'hist-6',
      });

      await waitFor(() => turnEnds === 3);

      const promptEntries = readFakeLog(logFile).filter(
        (e) => e.kind === 'received' && e.msg.method === 'session/prompt',
      );
      expect(promptEntries.length).toBe(3);
      // 3 ターン目（b6）までは同じセッションのまま（5 件まとめが 1 ターン扱い）
      expect(promptEntries[0]!.sessionId).toBe(promptEntries[1]!.sessionId);
      expect(promptEntries[1]!.sessionId).toBe(promptEntries[2]!.sessionId);

      const batchPrompt = promptEntries[1]!.msg.params?.prompt?.[0]?.text ?? '';
      expect(batchPrompt).toContain('=== inbound 1/5 ===');
      expect(batchPrompt).toContain('=== inbound 5/5 ===');
      expect(batchPrompt).not.toContain('hist-1');
      expect(batchPrompt).not.toContain('hist-2');
      expect(batchPrompt).toContain('hist-3');
      expect(batchPrompt).toContain('hist-4');
      expect(batchPrompt).toContain('hist-5');
      expect(batchPrompt).not.toContain('b6');
      expect(batchPrompt).toEndWith(
        '上の各メッセージについて、指示書の手順に従ってそれぞれ判断し、返すものは tool.ts で個別に（各 message_id を --reply_to に付けて）返す。返さないものには何もしない。最終回答は 1 行でよい。',
      );

      const sixthPrompt = promptEntries[2]!.msg.params?.prompt?.[0]?.text ?? '';
      expect(sixthPrompt).toContain('=== inbound ===');
      expect(sixthPrompt).toContain('b6');
      expect(sixthPrompt).toEndWith(
        '指示書の手順に従って判断し、返すなら tool.ts で返す。返さないなら何もしない。この会話への最終回答は 1 行でよい。',
      );

      // ターン完了ログ形式の確認
      expect(
        logs.some((l) =>
          /^ACP ターン完了: 種別=inbound×1 待ち=\d+\.\d 処理=\d+\.\d stopReason=end_turn$/.test(l),
        ),
      ).toBe(true);
      expect(
        logs.some((l) =>
          /^ACP ターン完了: 種別=inbound×5 待ち=\d+\.\d 処理=\d+\.\d stopReason=end_turn$/.test(l),
        ),
      ).toBe(true);
    } finally {
      await brain.stop();
    }
  });

  test('状態ファイルを毎回読み直して先頭に添付し、無ければ付けず警告は 1 回だけ出す', async () => {
    const dir = makeTempDir();
    const stateDir1 = path.join(dir, 'state1');
    const stateFile = path.join(dir, '現在の状態.md');
    const logFile1 = path.join(dir, 'fake1.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile1;

    fs.writeFileSync(stateFile, 'ペルソナ: 初号\n', 'utf8');

    let turnEnds1 = 0;
    const logs1: string[] = [];
    const brain1 = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir: stateDir1,
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      stateFilePath: stateFile,
      log: (m) => logs1.push(m),
      onTurnEnd: () => {
        turnEnds1 += 1;
      },
    });

    try {
      brain1.enqueue({ kind: 'inbound', inbound: 'm1', history: 'h1' });
      await waitFor(() => turnEnds1 === 1);

      fs.writeFileSync(stateFile, 'ペルソナ: 二号\n', 'utf8');
      brain1.enqueue({ kind: 'patrol', channels: [{ chatId: 'ch1', history: 'hp' }] });
      await waitFor(() => turnEnds1 === 2);

      fs.writeFileSync(stateFile, 'ペルソナ: 三号\n', 'utf8');
      brain1.enqueue({
        kind: 'journal',
        reason: 'shutdown',
        date: '2026-11-24',
        since: '2026-11-23T15:00:00.000Z',
        channels: [{ chatId: 'ch1', history: '[2026-11-24T01:00:00.000Z] a: hi  (id: 1)' }],
      });
      brain1.close();
      expect(await brain1.drain(5000)).toBe(true);
      expect(turnEnds1).toBe(3);

      const prompts1 = readFakeLog(logFile1)
        .filter((e) => e.kind === 'received' && e.msg.method === 'session/prompt')
        .map((e) => e.msg.params?.prompt?.[0]?.text ?? '');

      expect(prompts1[0]).toStartWith(
        '最初に C:/repo/GEMINI_BRAIN.md を読み、ACP モードの節に従うこと。現在の状態は各発言の先頭に添付されるので、現在の状態.md を読み直す必要はない。',
      );
      expect(prompts1[0]).toContain('=== 現在の状態（bot が添付。読み直し不要） ===\nペルソナ: 初号');
      expect(prompts1[1]).toStartWith('=== 現在の状態（bot が添付。読み直し不要） ===\nペルソナ: 二号');
      expect(prompts1[2]).toStartWith('=== 現在の状態（bot が添付。読み直し不要） ===\nペルソナ: 三号');
      expect(
        logs1.some((l) =>
          /^ACP ターン完了: 種別=patrol 待ち=\d+\.\d 処理=\d+\.\d stopReason=end_turn$/.test(l),
        ),
      ).toBe(true);
      expect(
        logs1.some((l) =>
          /^ACP ターン完了: 種別=journal 待ち=\d+\.\d 処理=\d+\.\d stopReason=end_turn$/.test(l),
        ),
      ).toBe(true);
    } finally {
      await brain1.stop();
    }

    // 状態ファイルが存在しない場合: 添付せず、警告は 1 回だけ
    const stateDir2 = path.join(dir, 'state2');
    const logFile2 = path.join(dir, 'fake2.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile2;

    let turnEnds2 = 0;
    const logs2: string[] = [];
    const brain2 = createAcpBrain({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir: stateDir2,
      instructionsPath: 'C:/repo/GEMINI_BRAIN.md',
      stateFilePath: path.join(dir, 'missing-state.md'),
      log: (m) => logs2.push(m),
      onTurnEnd: () => {
        turnEnds2 += 1;
      },
    });

    try {
      brain2.enqueue({ kind: 'inbound', inbound: 'm1', history: '' });
      await waitFor(() => turnEnds2 === 1);
      brain2.enqueue({ kind: 'inbound', inbound: 'm2', history: '' });
      await waitFor(() => turnEnds2 === 2);

      const prompts2 = readFakeLog(logFile2)
        .filter((e) => e.kind === 'received' && e.msg.method === 'session/prompt')
        .map((e) => e.msg.params?.prompt?.[0]?.text ?? '');

      expect(prompts2[0]).not.toContain('=== 現在の状態');
      expect(prompts2[1]).not.toContain('=== 現在の状態');
      expect(logs2.filter((l) => l.includes('状態ファイルを読み込めません')).length).toBe(1);
    } finally {
      await brain2.stop();
    }
  });
});
