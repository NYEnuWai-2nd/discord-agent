import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AcpClient,
  clearAcpSessionId,
  loadAcpModel,
  loadAcpSessionId,
  parseCommandLine,
  saveAcpModel,
  saveAcpSessionId,
} from '../src/acp-client.ts';

const FIXTURE_PATH = path.resolve(import.meta.dir, 'fixtures/fake-acp-agent.ts').replace(/\\/g, '/');

const tempDirs: string[] = [];
const envKeysToReset = [
  'FAKE_ACP_LOG_FILE',
  'FAKE_ACP_LOAD_SESSION',
  'FAKE_ACP_RESUME',
  'FAKE_ACP_FAIL_LOAD',
  'FAKE_ACP_FAIL_SET_MODEL',
  'FAKE_ACP_MODELS',
  'FAKE_ACP_OMIT_MODELS',
  'FAKE_ACP_PERMISSION_OPTIONS',
  'FAKE_ACP_IGNORE_CANCEL',
  'FAKE_ACP_TEST_UNSUPPORTED',
] as const;

function makeTempDir(prefix = 'discord-agent-acp-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type LogEntry = {
  kind: string;
  sessionId?: string;
  method?: string;
  msg: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { code?: number; message?: string };
  };
};

function readFakeLog(logFile: string): LogEntry[] {
  if (!fs.existsSync(logFile)) return [];
  const raw = fs.readFileSync(logFile, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LogEntry);
}

afterEach(() => {
  for (const key of envKeysToReset) {
    delete process.env[key];
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseCommandLine', () => {
  test('空白・タブ・ダブルクォート・シングルクォートを正しく分解する', () => {
    expect(parseCommandLine('agy acp')).toEqual(['agy', 'acp']);
    expect(parseCommandLine('  gemini\t--experimental-acp  ')).toEqual([
      'gemini',
      '--experimental-acp',
    ]);
    expect(parseCommandLine('"C:/Program Files/agy/agy.exe" acp')).toEqual([
      'C:/Program Files/agy/agy.exe',
      'acp',
    ]);
    expect(parseCommandLine("'single quoted' --flag=\"a b\" ''")).toEqual([
      'single quoted',
      '--flag=a b',
      '',
    ]);
    expect(parseCommandLine('"say \\"hi\\"" "C:\\win\\path"')).toEqual([
      'say "hi"',
      'C:\\win\\path',
    ]);
    expect(parseCommandLine('   ')).toEqual([]);
  });

  test('閉じられていないクォートは Error を投げる', () => {
    expect(() => parseCommandLine('"unclosed')).toThrow();
    expect(() => parseCommandLine("'unclosed")).toThrow();
  });
});

describe('AcpClient', () => {
  test('initialize・session/new・model 指定・prompt・権限自動許可・未対応メソッド拒否・通知ログが動作する', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;
    process.env.FAKE_ACP_TEST_UNSUPPORTED = '1';

    const logs: string[] = [];
    const client = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      model: 'model-b',
      log: (m) => logs.push(m),
    });

    try {
      const startRes = await client.start();
      expect(startRes.isNewSession).toBe(true);
      expect(startRes.sessionId).toMatch(/^fake-sess-/);
      expect(loadAcpSessionId(stateDir)).toBe(startRes.sessionId);

      const promptRes = await client.prompt('hello world');
      expect(promptRes.stopReason).toBe('end_turn');
      expect(client.lastUsedTokens).toBe(123);

      expect(logs.some((l) => l.includes('[acp tool] fake-shell-tool'))).toBe(true);
      expect(logs.some((l) => l.includes('[acp response] echo:hello world'))).toBe(true);

      const entries = readFakeLog(logFile);
      const methods = entries.filter((e) => e.kind === 'received').map((e) => e.msg.method);
      expect(methods).toContain('initialize');
      expect(methods).toContain('session/new');
      expect(methods).toContain('session/set_model');
      expect(methods).toContain('session/prompt');

      const permResp = entries.find(
        (e) => e.kind === 'client_response' && e.method === 'session/request_permission',
      );
      expect(permResp?.msg.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-always-1' },
      });

      const fsResp = entries.find(
        (e) => e.kind === 'client_response' && e.method === 'fs/read_text_file',
      );
      expect(fsResp?.msg.error?.code).toBe(-32601);
    } finally {
      await client.stop();
    }
  });

  test('allow_always が無ければ allow_once、どちらも無ければ先頭を選ぶ', async () => {
    const dir = makeTempDir();
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;
    process.env.FAKE_ACP_PERMISSION_OPTIONS = 'only_once';

    const c1 = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir: path.join(dir, 's1'),
      log: () => {},
    });
    try {
      await c1.start();
      await c1.prompt('p1');
    } finally {
      await c1.stop();
    }

    const entries1 = readFakeLog(logFile);
    const perm1 = entries1.find(
      (e) => e.kind === 'client_response' && e.method === 'session/request_permission',
    );
    expect(perm1?.msg.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once-1' },
    });

    fs.rmSync(logFile, { force: true });
    process.env.FAKE_ACP_PERMISSION_OPTIONS = 'fallback_first';

    const c2 = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir: path.join(dir, 's2'),
      log: () => {},
    });
    try {
      await c2.start();
      await c2.prompt('p2');
    } finally {
      await c2.stop();
    }

    const entries2 = readFakeLog(logFile);
    const perm2 = entries2.find(
      (e) => e.kind === 'client_response' && e.method === 'session/request_permission',
    );
    expect(perm2?.msg.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'first-opt' },
    });
  });

  test('保存済み sessionId を session/load または session/resume で再開し、失敗時は session/new にフォールバックする', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;

    saveAcpSessionId(stateDir, 'saved-sess-1');

    // 1. resume 無し・loadSession=true → session/load（load 中の session/update は無視）
    const logs1: string[] = [];
    const c1 = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      log: (m) => logs1.push(m),
    });
    try {
      const r1 = await c1.start();
      expect(r1.isNewSession).toBe(false);
      expect(r1.sessionId).toBe('saved-sess-1');
      await c1.prompt('after load');
      expect(logs1.some((l) => l.includes('REPLAY_IGNORED'))).toBe(false);
    } finally {
      await c1.stop();
    }
    const methods1 = readFakeLog(logFile)
      .filter((e) => e.kind === 'received')
      .map((e) => e.msg.method);
    expect(methods1).toContain('session/load');
    expect(methods1).not.toContain('session/new');

    // 2. sessionCapabilities.resume あり → session/resume を優先
    fs.rmSync(logFile, { force: true });
    process.env.FAKE_ACP_RESUME = '1';
    const c2 = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      log: () => {},
    });
    try {
      const r2 = await c2.start();
      expect(r2.isNewSession).toBe(false);
      expect(r2.sessionId).toBe('saved-sess-1');
    } finally {
      await c2.stop();
    }
    const methods2 = readFakeLog(logFile)
      .filter((e) => e.kind === 'received')
      .map((e) => e.msg.method);
    expect(methods2).toContain('session/resume');
    expect(methods2).not.toContain('session/load');

    // 3. resume/load が失敗したら session/new にフォールバックし、新しい sessionId を保存
    fs.rmSync(logFile, { force: true });
    process.env.FAKE_ACP_FAIL_LOAD = '1';
    const c3 = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      log: () => {},
    });
    try {
      const r3 = await c3.start();
      expect(r3.isNewSession).toBe(true);
      expect(r3.sessionId).not.toBe('saved-sess-1');
      expect(loadAcpSessionId(stateDir)).toBe(r3.sessionId);
    } finally {
      await c3.stop();
    }

    clearAcpSessionId(stateDir);
    expect(loadAcpSessionId(stateDir)).toBeUndefined();
  });

  test('session/set_model が失敗しても警告ログのみで続行する', async () => {
    const dir = makeTempDir();
    process.env.FAKE_ACP_FAIL_SET_MODEL = '1';
    const logs: string[] = [];
    const client = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir: path.join(dir, 'state'),
      model: 'model-b',
      log: (m) => logs.push(m),
    });
    try {
      const res = await client.start();
      expect(res.sessionId).toMatch(/^fake-sess-/);
      expect(logs.some((l) => l.includes('session/set_model'))).toBe(true);
    } finally {
      await client.stop();
    }
  });

  test('タイムアウト時に session/cancel 通知を送り、応答が返れば完了、無応答ならエラーになる', async () => {
    const dir = makeTempDir();
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;

    const c1 = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir: path.join(dir, 's1'),
      promptTimeoutSec: 0.1,
      cancelGraceMs: 2000,
      log: () => {},
    });
    try {
      await c1.start();
      const res = await c1.prompt('TRIGGER_HANG_CANCEL');
      expect(res.stopReason).toBe('cancelled');
      const methods = readFakeLog(logFile)
        .filter((e) => e.kind === 'received')
        .map((e) => e.msg.method);
      expect(methods).toContain('session/cancel');
    } finally {
      await c1.stop();
    }

    const c2 = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir: path.join(dir, 's2'),
      promptTimeoutSec: 0.08,
      cancelGraceMs: 120,
      log: () => {},
    });
    try {
      await c2.start();
      await expect(c2.prompt('TRIGGER_HANG_FOREVER')).rejects.toThrow(/タイムアウト/);
    } finally {
      await c2.stop();
    }
  });

  test('子プロセスが終了したら保留中の prompt をエラーにし、onExit を呼ぶ', async () => {
    const dir = makeTempDir();
    let exitCalled = false;
    let resolveExit!: () => void;
    const exitDone = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const client = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir: path.join(dir, 'state'),
      log: () => {},
      onExit: () => {
        exitCalled = true;
        resolveExit();
      },
    });

    await client.start();
    await expect(client.prompt('TRIGGER_CRASH')).rejects.toThrow(/終了/);
    await exitDone;
    expect(exitCalled).toBe(true);
  });

  test('getModels と setModel が models 状態の保持・更新・失敗時の維持を行う', async () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    const logFile = path.join(dir, 'fake.jsonl');
    process.env.FAKE_ACP_LOG_FILE = logFile;
    process.env.FAKE_ACP_MODELS = 'gemini-4-hydrogen-low,gemini-4-hydrogen-high';

    const client = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir,
      log: () => {},
    });

    expect(client.getModels()).toEqual({ available: [] });

    try {
      await client.start();
      expect(client.getModels()).toEqual({
        current: 'gemini-4-hydrogen-low',
        available: ['gemini-4-hydrogen-low', 'gemini-4-hydrogen-high'],
      });

      await client.setModel('gemini-4-hydrogen-high');
      expect(client.getModels()).toEqual({
        current: 'gemini-4-hydrogen-high',
        available: ['gemini-4-hydrogen-low', 'gemini-4-hydrogen-high'],
      });

      const entries = readFakeLog(logFile);
      const setModelReq = entries.find(
        (e) => e.kind === 'received' && e.msg.method === 'session/set_model',
      );
      expect(setModelReq?.msg.params).toMatchObject({
        modelId: 'gemini-4-hydrogen-high',
      });
    } finally {
      await client.stop();
    }

    process.env.FAKE_ACP_FAIL_SET_MODEL = '1';
    const failClient = new AcpClient({
      command: `bun "${FIXTURE_PATH}"`,
      cwd: dir,
      stateDir: path.join(dir, 'state2'),
      log: () => {},
    });
    try {
      await failClient.start();
      let caught: unknown;
      try {
        await failClient.setModel('gemini-4-hydrogen-high');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/set_model/);
      expect(failClient.getModels().current).toBe('gemini-4-hydrogen-low');
    } finally {
      await failClient.stop();
    }
    delete process.env.FAKE_ACP_MODELS;
  });

  test('loadAcpModel / saveAcpModel が保存・読込・不正値フォールバックを行う', () => {
    const dir = makeTempDir();
    const stateDir = path.join(dir, 'state');
    expect(loadAcpModel(stateDir)).toBeUndefined();

    saveAcpModel(stateDir, 'gemini-4-hydrogen-high');
    expect(loadAcpModel(stateDir)).toBe('gemini-4-hydrogen-high');

    fs.writeFileSync(path.join(stateDir, 'acp-model.json'), '{bad json', 'utf8');
    expect(loadAcpModel(stateDir)).toBeUndefined();
  });
});
