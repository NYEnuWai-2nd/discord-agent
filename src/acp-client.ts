import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** コマンドライン文字列を空白区切りでトークン化する（シングルクォート・ダブルクォート対応） */
export function parseCommandLine(s: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '\\' && i + 1 < s.length && s[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    hasToken = true;
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else {
      current += ch;
    }
  }

  if (inSingle || inDouble) {
    throw new Error('コマンドラインのクォートが閉じていません');
  }
  if (hasToken) {
    args.push(current);
  }
  return args;
}

const ACP_SESSION_FILE = 'acp-session.json';
const ACP_MODEL_FILE = 'acp-model.json';
const DEFAULT_PROMPT_TIMEOUT_SEC = 300;
const DEFAULT_CANCEL_GRACE_MS = 30_000;

/** 保存済みの ACP セッション ID を `{stateDir}/acp-session.json` から読み出す */
export function loadAcpSessionId(stateDir: string): string | undefined {
  try {
    const raw = readFileSync(join(stateDir, ACP_SESSION_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const sessionId = (parsed as Record<string, unknown>).sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

/** ACP セッション ID を `{stateDir}/acp-session.json` に保存する */
export function saveAcpSessionId(stateDir: string, sessionId: string): void {
  mkdirSync(stateDir, { recursive: true });
  const payload = {
    sessionId,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(join(stateDir, ACP_SESSION_FILE), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

/** `{stateDir}/acp-session.json` を削除する */
export function clearAcpSessionId(stateDir: string): void {
  rmSync(join(stateDir, ACP_SESSION_FILE), { force: true });
}

/** 保存済みの ACP モデル ID を `{stateDir}/acp-model.json` から読み出す */
export function loadAcpModel(stateDir: string): string | undefined {
  try {
    const raw = readFileSync(join(stateDir, ACP_MODEL_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const modelId = (parsed as Record<string, unknown>).modelId;
    return typeof modelId === 'string' && modelId.length > 0 ? modelId : undefined;
  } catch {
    return undefined;
  }
}

/** ACP モデル ID を `{stateDir}/acp-model.json` に保存する */
export function saveAcpModel(stateDir: string, modelId: string): void {
  mkdirSync(stateDir, { recursive: true });
  const payload = {
    modelId,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(join(stateDir, ACP_MODEL_FILE), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

type JsonRpcId = number | string;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type AcpModelInfo = {
  modelId: string;
  name?: string;
};

type AcpModelsState = {
  availableModels?: AcpModelInfo[];
  currentModelId?: string;
};

type InitializeResult = {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    sessionCapabilities?: {
      resume?: unknown;
    };
  };
};

type SessionNewResult = {
  sessionId: string;
  models?: AcpModelsState;
  configOptions?: unknown;
};

type SessionResumeOrLoadResult = {
  sessionId?: string;
  models?: AcpModelsState;
  configOptions?: unknown;
};

/**
 * ACP の session config options（例: OpenCode）からモデル選択肢を取り出す。
 * category が "model"（無ければ id が "model"）の select 型を探し、グループ化された選択肢も平らにする。
 */
export function modelsFromConfigOptions(
  configOptions: unknown,
): { configId: string; available: string[]; current?: string } | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  const opt =
    configOptions.find((o) => isObj(o) && o.category === 'model' && o.type === 'select') ??
    configOptions.find((o) => isObj(o) && o.id === 'model' && o.type === 'select');
  if (!isObj(opt) || typeof opt.id !== 'string') return undefined;
  const available: string[] = [];
  const collect = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (!isObj(it)) continue;
      if (typeof it.value === 'string' && it.value) available.push(it.value);
      else if (Array.isArray(it.options)) collect(it.options);
    }
  };
  collect(opt.options);
  return {
    configId: opt.id,
    available,
    ...(typeof opt.currentValue === 'string' && opt.currentValue ? { current: opt.currentValue } : {}),
  };
}

type PermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

export type AcpClientOptions = {
  command: string | string[];
  cwd: string;
  stateDir: string;
  model?: string;
  promptTimeoutSec?: number;
  cancelGraceMs?: number;
  fresh?: boolean;
  log?: (msg: string) => void;
  onExit?: (info: { code: number | null; signalCode: string | null }) => void;
};

export type AcpStartResult = {
  sessionId: string;
  isNewSession: boolean;
};

/** `session/request_permission` の選択肢から allow_always → allow_once → 先頭 の順で選ぶ */
function pickPermissionOption(options: unknown): PermissionOption | undefined {
  if (!Array.isArray(options) || options.length === 0) {
    return undefined;
  }
  const valid = options.filter(
    (o): o is PermissionOption =>
      typeof o === 'object' &&
      o !== null &&
      typeof (o as Record<string, unknown>).optionId === 'string',
  );
  if (valid.length === 0) return undefined;
  return (
    valid.find((o) => o.kind === 'allow_always') ??
    valid.find((o) => o.kind === 'allow_once') ??
    valid[0]
  );
}

/** `agent_message_chunk` 通知からテキストを取り出す */
function extractChunkText(update: Record<string, unknown>): string {
  const content = update.content;
  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'object' &&
        block !== null &&
        typeof (block as Record<string, unknown>).text === 'string'
          ? ((block as Record<string, unknown>).text as string)
          : '',
      )
      .join('');
  }
  if (typeof update.text === 'string') return update.text;
  const delta = update.delta;
  if (typeof delta === 'object' && delta !== null && typeof (delta as Record<string, unknown>).text === 'string') {
    return (delta as Record<string, unknown>).text as string;
  }
  return '';
}

/** 改行区切り JSON-RPC 2.0 over stdio を使う汎用 ACP クライアント */
export class AcpClient {
  private readonly argv: string[];
  private readonly cwd: string;
  private readonly stateDir: string;
  private readonly model?: string;
  private readonly promptTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly fresh: boolean;
  private readonly log: (msg: string) => void;
  private readonly onExit?: (info: { code: number | null; signalCode: string | null }) => void;

  private proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private sessionId: string | undefined;
  private isNewSession = false;
  private suppressUpdates = false;
  private turnOutput = '';
  private usedTokens: number | undefined;
  private availableModels: string[] = [];
  private currentModelId: string | undefined;
  /** モデルを session config option で切り替えるエージェントの場合、その configId */
  private modelConfigId: string | undefined;
  private exited = false;
  private stopping = false;
  private promptInFlight = false;

  constructor(opts: AcpClientOptions) {
    this.argv = Array.isArray(opts.command) ? [...opts.command] : parseCommandLine(opts.command);
    if (this.argv.length === 0) {
      throw new Error('ACP コマンドが空です');
    }
    this.cwd = opts.cwd;
    this.stateDir = opts.stateDir;
    this.model = opts.model;
    const timeoutSec = opts.promptTimeoutSec ?? DEFAULT_PROMPT_TIMEOUT_SEC;
    this.promptTimeoutMs = Math.max(1, timeoutSec * 1000);
    this.cancelGraceMs = opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.fresh = opts.fresh ?? false;
    this.log = opts.log ?? ((msg) => console.log(msg));
    this.onExit = opts.onExit;
  }

  /** 現在のセッション ID */
  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /** 直近の `usage_update` で報告された `used` 値 */
  get lastUsedTokens(): number | undefined {
    return this.usedTokens;
  }

  /** 子プロセスを起動し、initialize とセッション開始（再開または新規作成）を行う */
  async start(): Promise<AcpStartResult> {
    if (this.proc) {
      throw new Error('AcpClient は既に起動しています');
    }

    this.stopping = false;
    this.exited = false;

    const proc = Bun.spawn(this.argv, {
      cwd: this.cwd,
      env: process.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.proc = proc;

    void this.readStdout(proc.stdout);
    void this.readStderr(proc.stderr);
    void proc.exited.then((code) => {
      this.handleProcessExit(code, proc.signalCode ?? null);
    });

    const initResult = await this.request<InitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    const caps = initResult?.agentCapabilities;
    const supportsResume = Boolean(caps?.sessionCapabilities?.resume);
    const supportsLoad = caps?.loadSession === true;

    const savedId = this.fresh ? undefined : loadAcpSessionId(this.stateDir);
    let models: AcpModelsState | undefined;
    let configOptions: unknown;

    if (savedId && (supportsResume || supportsLoad)) {
      const method = supportsResume ? 'session/resume' : 'session/load';
      this.suppressUpdates = true;
      try {
        const resumed = await this.request<SessionResumeOrLoadResult>(method, {
          sessionId: savedId,
          cwd: this.cwd,
          mcpServers: [],
        });
        this.sessionId = typeof resumed?.sessionId === 'string' && resumed.sessionId ? resumed.sessionId : savedId;
        this.isNewSession = false;
        models = resumed?.models;
        configOptions = resumed?.configOptions;
        this.log(`ACP セッション再開 (${method}): ${this.sessionId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`ACP ${method} に失敗したため新規セッションを作成します: ${msg}`);
      } finally {
        this.suppressUpdates = false;
      }
    }

    if (!this.sessionId) {
      const created = await this.request<SessionNewResult>('session/new', {
        cwd: this.cwd,
        mcpServers: [],
      });
      if (!created || typeof created.sessionId !== 'string' || !created.sessionId) {
        throw new Error('session/new が有効な sessionId を返しませんでした');
      }
      this.sessionId = created.sessionId;
      this.isNewSession = true;
      models = created.models;
      configOptions = created.configOptions;
      saveAcpSessionId(this.stateDir, this.sessionId);
      this.log(`ACP セッション新規作成: ${this.sessionId}`);
    }

    this.availableModels = Array.isArray(models?.availableModels)
      ? models.availableModels
          .map((m) => m?.modelId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    this.currentModelId =
      typeof models?.currentModelId === 'string' && models.currentModelId.length > 0
        ? models.currentModelId
        : undefined;
    this.modelConfigId = undefined;
    if (this.availableModels.length === 0) {
      const fromConfig = modelsFromConfigOptions(configOptions);
      if (fromConfig) {
        this.modelConfigId = fromConfig.configId;
        this.availableModels = fromConfig.available;
        this.currentModelId = fromConfig.current;
      }
    }

    if (this.model && this.availableModels.length > 0) {
      const available = this.availableModels.includes(this.model);
      if (available) {
        try {
          await this.setModel(this.model);
          this.log(`ACP モデル設定: ${this.model}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`警告: モデル設定 (${this.model}) に失敗しました: ${msg}`);
        }
      } else {
        this.log(`警告: 指定モデル "${this.model}" は availableModels に含まれていません`);
      }
    }

    return {
      sessionId: this.sessionId,
      isNewSession: this.isNewSession,
    };
  }

  /** セッションの使用モデルを切り替える */
  async setModel(modelId: string): Promise<void> {
    if (!this.sessionId || this.exited || !this.proc) {
      throw new Error('ACP セッションが開始されていません');
    }
    if (this.modelConfigId) {
      await this.request('session/set_config_option', {
        sessionId: this.sessionId,
        configId: this.modelConfigId,
        value: modelId,
      });
    } else {
      await this.request('session/set_model', {
        sessionId: this.sessionId,
        modelId,
      });
    }
    this.currentModelId = modelId;
  }

  /** 現在のモデル ID と利用可能なモデル ID 一覧を返す */
  getModels(): { current?: string; available: string[] } {
    return {
      ...(this.currentModelId !== undefined ? { current: this.currentModelId } : {}),
      available: [...this.availableModels],
    };
  }

  /** 1 ターン分のプロンプトを送り、`stopReason` を返す */
  async prompt(text: string): Promise<{ stopReason: string }> {
    if (!this.sessionId || this.exited || !this.proc) {
      throw new Error('ACP セッションが開始されていません');
    }
    if (this.promptInFlight) {
      throw new Error('ACP prompt は同時に 1 件しか実行できません');
    }

    this.promptInFlight = true;
    this.turnOutput = '';

    let promptTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const reqId = this.nextId++;

    const responsePromise = new Promise<{ stopReason?: string }>((resolve, reject) => {
      this.pending.set(reqId, {
        method: 'session/prompt',
        resolve: (value) => resolve((value ?? {}) as { stopReason?: string }),
        reject,
      });

      try {
        this.sendLine({
          jsonrpc: '2.0',
          id: reqId,
          method: 'session/prompt',
          params: {
            sessionId: this.sessionId,
            prompt: [{ type: 'text', text }],
          },
        });
      } catch (err) {
        this.pending.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      promptTimer = setTimeout(() => {
        if (!this.pending.has(reqId)) return;
        this.log(`警告: ACP prompt が ${Math.round(this.promptTimeoutMs / 1000)} 秒でタイムアウトしたため session/cancel を送信します`);
        try {
          this.notify('session/cancel', { sessionId: this.sessionId });
        } catch {
          // 既にプロセスが終了している場合は cancelTimer または onExit で解決される
        }
        cancelTimer = setTimeout(() => {
          const entry = this.pending.get(reqId);
          if (!entry) return;
          this.pending.delete(reqId);
          entry.reject(new Error('ACP session/cancel 後の応答待ちがタイムアウトしました'));
        }, this.cancelGraceMs);
      }, this.promptTimeoutMs);
    });

    try {
      const result = await responsePromise;
      return {
        stopReason: typeof result.stopReason === 'string' ? result.stopReason : 'end_turn',
      };
    } finally {
      if (promptTimer !== undefined) clearTimeout(promptTimer);
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      this.promptInFlight = false;
      const tail = this.turnOutput.slice(-200).replace(/\r?\n/g, ' ').trim();
      if (tail) {
        this.log(`[acp response] ${tail}`);
      }
    }
  }

  /** 子プロセスを終了し、保留中の要求をすべてエラーにする */
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      this.rejectAllPending(new Error('AcpClient が停止されました'));
      if (this.proc && !this.exited) {
        try {
          this.proc.kill();
        } catch {
          // 既に終了している場合は無視
        }
      }
    }
    return this.proc ? this.proc.exited.then(() => undefined) : Promise.resolve();
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.exited || !this.proc) {
      return Promise.reject(new Error(`ACP プロセスは既に終了しています (${method})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.sendLine({
          jsonrpc: '2.0',
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.sendLine({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  private sendLine(payload: unknown): void {
    if (!this.proc || this.exited) {
      throw new Error('ACP プロセスの stdin に書き込めません');
    }
    const line = JSON.stringify(payload) + '\n';
    void this.proc.stdin.write(line);
  }

  private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.drainLines(buffer, (line) => this.handleStdoutLine(line));
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        this.handleStdoutLine(buffer.replace(/\r$/, ''));
      }
    } catch (err) {
      if (!this.stopping && !this.exited) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`ACP stdout 読み込みエラー: ${msg}`);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.drainLines(buffer, (line) => {
          if (line.trim()) {
            this.log(`[acp stderr] ${line}`);
          }
        });
      }
      buffer += decoder.decode();
      const tail = buffer.replace(/\r$/, '');
      if (tail.trim()) {
        this.log(`[acp stderr] ${tail}`);
      }
    } catch {
      // stderr の終了時エラーは無視
    } finally {
      reader.releaseLock();
    }
  }

  private drainLines(buffer: string, onLine: (line: string) => void): string {
    let start = 0;
    while (true) {
      const idx = buffer.indexOf('\n', start);
      if (idx === -1) break;
      const line = buffer.slice(start, idx).replace(/\r$/, '');
      start = idx + 1;
      onLine(line);
    }
    return buffer.slice(start);
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.log(`警告: ACP から不正な JSON-RPC メッセージを受信: ${trimmed.slice(0, 200)}`);
        return;
      }
      msg = parsed as Record<string, unknown>;
    } catch {
      this.log(`警告: ACP stdout の非 JSON 行を無視: ${trimmed.slice(0, 200)}`);
      return;
    }

    const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : undefined;

    // 1. エージェントからクライアントへのリクエスト
    if (hasId && method !== undefined) {
      this.handleAgentRequest(msg.id as JsonRpcId, method, msg.params);
      return;
    }

    // 2. クライアントが送ったリクエストへのレスポンス
    if (hasId) {
      const id = msg.id as JsonRpcId;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);

      if (msg.error !== undefined && msg.error !== null) {
        const errObj = msg.error as Record<string, unknown>;
        const code = typeof errObj.code === 'number' ? errObj.code : -32000;
        const message = typeof errObj.message === 'string' ? errObj.message : 'JSON-RPC error';
        entry.reject(new Error(`${entry.method} failed (${code}): ${message}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // 3. 通知
    if (method !== undefined) {
      this.handleNotification(method, msg.params);
    }
  }

  private handleAgentRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method === 'session/request_permission') {
      const obj =
        typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
      const chosen = pickPermissionOption(obj.options);
      if (!chosen) {
        this.sendResponseError(id, -32602, 'Invalid params: options missing');
        return;
      }
      this.sendResponseResult(id, {
        outcome: {
          outcome: 'selected',
          optionId: chosen.optionId,
        },
      });
      return;
    }

    // fs/* や terminal/* 等は未対応
    this.sendResponseError(id, -32601, `Method not found: ${method}`);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || this.suppressUpdates) {
      return;
    }
    if (typeof params !== 'object' || params === null) return;
    const update = (params as Record<string, unknown>).update;
    if (typeof update !== 'object' || update === null) return;

    const u = update as Record<string, unknown>;
    const kind = u.sessionUpdate;
    if (kind === 'tool_call') {
      const label =
        (typeof u.title === 'string' && u.title) ||
        (typeof u.name === 'string' && u.name) ||
        'tool_call';
      this.log(`[acp tool] ${label.replace(/\r?\n/g, ' ')}`);
    } else if (kind === 'agent_message_chunk') {
      const chunk = extractChunkText(u);
      if (chunk) {
        this.turnOutput += chunk;
      }
    } else if (kind === 'usage_update') {
      if (typeof u.used === 'number' && Number.isFinite(u.used)) {
        this.usedTokens = u.used;
      }
    }
  }

  private sendResponseResult(id: JsonRpcId, result: unknown): void {
    try {
      this.sendLine({ jsonrpc: '2.0', id, result });
    } catch {
      // 終了済みなら無視
    }
  }

  private sendResponseError(id: JsonRpcId, code: number, message: string): void {
    try {
      this.sendLine({ jsonrpc: '2.0', id, error: { code, message } });
    } catch {
      // 終了済みなら無視
    }
  }

  private handleProcessExit(code: number | null, signalCode: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.rejectAllPending(new Error(`ACP プロセスが終了しました (code=${code ?? 'null'})`));
    this.onExit?.({ code, signalCode });
  }

  private rejectAllPending(err: Error): void {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      entry.reject(err);
    }
  }
}
