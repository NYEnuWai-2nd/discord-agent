import { appendFileSync } from 'node:fs';

type JsonRpcMsg = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

const logFile = process.env.FAKE_ACP_LOG_FILE;

function recordLog(entry: unknown): void {
  if (!logFile) return;
  appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let clientReqSeq = 1;
const clientPending = new Map<number | string, (msg: JsonRpcMsg) => void>();

function requestClient(method: string, params: unknown): Promise<JsonRpcMsg> {
  const id = `agent-req-${clientReqSeq++}`;
  return new Promise<JsonRpcMsg>((resolve) => {
    clientPending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

let activeSessionId = '';
let cancelWaiter: (() => void) | undefined;
let currentModelId = 'model-a';

function buildModelsState(): { availableModels: Array<{ modelId: string; name: string }>; currentModelId: string } | undefined {
  if (process.env.FAKE_ACP_OMIT_MODELS === '1') {
    return undefined;
  }
  const raw = process.env.FAKE_ACP_MODELS;
  const ids = raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : ['model-a', 'model-b'];
  if (!ids.includes(currentModelId) && ids.length > 0) {
    currentModelId = ids[0]!;
  }
  return {
    availableModels: ids.map((modelId) => ({ modelId, name: modelId })),
    currentModelId,
  };
}

function extractPromptText(params: Record<string, unknown> | undefined): string {
  const prompt = params?.prompt;
  if (!Array.isArray(prompt)) return '';
  return prompt
    .map((b) =>
      typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>).text === 'string'
        ? ((b as Record<string, unknown>).text as string)
        : '',
    )
    .join('\n');
}

async function handleRequest(msg: JsonRpcMsg): Promise<void> {
  const id = msg.id!;
  const method = msg.method!;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  if (method === 'initialize') {
    const loadSession = process.env.FAKE_ACP_LOAD_SESSION !== '0';
    const hasResume = process.env.FAKE_ACP_RESUME === '1';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession,
          ...(hasResume ? { sessionCapabilities: { resume: {} } } : {}),
        },
      },
    });
    return;
  }

  if (method === 'session/new') {
    activeSessionId = `fake-sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const models = buildModelsState();
    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId: activeSessionId,
        ...(models ? { models } : {}),
      },
    });
    return;
  }

  if (method === 'session/load' || method === 'session/resume') {
    if (process.env.FAKE_ACP_FAIL_LOAD === '1') {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: `${method} failed` },
      });
      return;
    }
    const sid = typeof params.sessionId === 'string' ? params.sessionId : '';
    activeSessionId = sid;
    if (method === 'session/load') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'REPLAY_IGNORED' },
          },
        },
      });
    }
    const models = buildModelsState();
    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId: sid,
        ...(models ? { models } : {}),
      },
    });
    return;
  }

  if (method === 'session/set_model') {
    if (process.env.FAKE_ACP_FAIL_SET_MODEL === '1') {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'set_model failed' },
      });
      return;
    }
    if (typeof params.modelId === 'string' && params.modelId.length > 0) {
      currentModelId = params.modelId;
    }
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'session/prompt') {
    const text = extractPromptText(params);

    if (text.includes('TRIGGER_CRASH')) {
      process.exit(1);
    }

    const delayMatch = /TRIGGER_DELAY:(\d+)/.exec(text);
    if (delayMatch) {
      await Bun.sleep(Number(delayMatch[1]));
    }

    if (text.includes('TRIGGER_HANG_FOREVER')) {
      return;
    }

    if (text.includes('TRIGGER_HANG_CANCEL')) {
      await new Promise<void>((resolve) => {
        cancelWaiter = resolve;
      });
      send({
        jsonrpc: '2.0',
        id,
        result: { stopReason: 'cancelled' },
      });
      return;
    }

    const permMode = process.env.FAKE_ACP_PERMISSION_OPTIONS ?? 'all';
    const options =
      permMode === 'only_once'
        ? [
            { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' },
            { optionId: 'allow-once-1', name: 'Allow Once', kind: 'allow_once' },
          ]
        : permMode === 'fallback_first'
          ? [
              { optionId: 'first-opt', name: 'First', kind: 'reject_once' },
              { optionId: 'second-opt', name: 'Second', kind: 'reject_always' },
            ]
          : [
              { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' },
              { optionId: 'allow-once-1', name: 'Allow Once', kind: 'allow_once' },
              { optionId: 'allow-always-1', name: 'Allow Always', kind: 'allow_always' },
            ];

    const permResp = await requestClient('session/request_permission', {
      sessionId: activeSessionId,
      options,
    });
    recordLog({ kind: 'client_response', method: 'session/request_permission', msg: permResp });

    if (text.includes('TRIGGER_UNSUPPORTED') || process.env.FAKE_ACP_TEST_UNSUPPORTED === '1') {
      const fsResp = await requestClient('fs/read_text_file', { path: 'dummy.txt' });
      recordLog({ kind: 'client_response', method: 'fs/read_text_file', msg: fsResp });
    }

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'tool_call',
          title: 'fake-shell-tool',
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `echo:${text.slice(0, 60)}` },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: 123,
        },
      },
    });

    send({
      jsonrpc: '2.0',
      id,
      result: { stopReason: 'end_turn' },
    });
    return;
  }

  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed) as JsonRpcMsg;
  recordLog({ kind: 'received', sessionId: activeSessionId, msg });

  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = clientPending.get(msg.id);
    if (resolve) {
      clientPending.delete(msg.id);
      resolve(msg);
    }
    return;
  }

  if (msg.id !== undefined && msg.method !== undefined) {
    void handleRequest(msg);
    return;
  }

  if (msg.method === 'session/cancel') {
    if (process.env.FAKE_ACP_IGNORE_CANCEL !== '1' && cancelWaiter) {
      const w = cancelWaiter;
      cancelWaiter = undefined;
      w();
    }
  }
}

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buf = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  while (true) {
    const idx = buf.indexOf('\n');
    if (idx === -1) break;
    const line = buf.slice(0, idx).replace(/\r$/, '');
    buf = buf.slice(idx + 1);
    handleLine(line);
  }
}
