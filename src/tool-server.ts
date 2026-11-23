import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BotConfig } from './config.ts';
import type { DiscordTools } from './discord.ts';
import { toolShapes } from './tool-schemas.ts';
import { addPerson, notePerson, setState } from './workspace-tools.ts';

export type ToolRequestContext = {
  tools: DiscordTools;
  token: string;
  workspace?: string;
  getConfig?: () => BotConfig;
};

type ToolHandler = (
  ctx: ToolRequestContext,
  rawArgs: Record<string, unknown>,
) => { ok: true; exec: () => Promise<string> } | { ok: false; error: string };

/** Zod の検証エラーを 1 行のメッセージに整形する */
function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

/** スキーマ検証と実行処理を対にして登録するヘルパー */
function makeHandler<S extends z.ZodType>(
  schema: S,
  run: (ctx: ToolRequestContext, args: z.infer<S>) => Promise<string>,
): ToolHandler {
  return (ctx, rawArgs) => {
    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      return { ok: false, error: `invalid arguments: ${formatZodIssues(parsed.error)}` };
    }
    return { ok: true, exec: () => run(ctx, parsed.data) };
  };
}

function requireWorkspace(ctx: ToolRequestContext): string {
  if (!ctx.workspace) {
    throw new Error('workspace が設定されていません');
  }
  return ctx.workspace;
}

function requireWorkspaceAndConfig(ctx: ToolRequestContext): {
  workspace: string;
  getConfig: () => BotConfig;
} {
  if (!ctx.workspace || !ctx.getConfig) {
    throw new Error('workspace または config が設定されていません');
  }
  return { workspace: ctx.workspace, getConfig: ctx.getConfig };
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  reply: makeHandler(z.object(toolShapes.reply), (ctx, args) => ctx.tools.reply(args)),
  react: makeHandler(z.object(toolShapes.react), (ctx, args) => ctx.tools.react(args)),
  edit_message: makeHandler(z.object(toolShapes.edit_message), (ctx, args) =>
    ctx.tools.editMessage(args),
  ),
  download_attachment: makeHandler(z.object(toolShapes.download_attachment), (ctx, args) =>
    ctx.tools.downloadAttachment(args),
  ),
  fetch_messages: makeHandler(z.object(toolShapes.fetch_messages), (ctx, args) =>
    ctx.tools.fetchMessages(args),
  ),
  list_members: makeHandler(z.object(toolShapes.list_members), (ctx, args) =>
    ctx.tools.listMembers({
      channel: args.channel,
      memberId: args.user_id,
      limit: args.limit,
    }),
  ),
  set_state: makeHandler(z.object(toolShapes.set_state), (ctx, args) => {
    const { workspace, getConfig } = requireWorkspaceAndConfig(ctx);
    return setState({ tools: ctx.tools, workspace, getConfig }, args);
  }),
  add_person: makeHandler(z.object(toolShapes.add_person), (ctx, args) => {
    const workspace = requireWorkspace(ctx);
    return addPerson({ workspace }, args);
  }),
  note_person: makeHandler(z.object(toolShapes.note_person), (ctx, args) => {
    const workspace = requireWorkspace(ctx);
    return notePerson({ workspace }, args);
  }),
};

/** Bearer トークンを定数時間で照合する */
function verifyBearerToken(authHeader: string | null, expectedToken: string): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const actual = Buffer.from(authHeader.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/**
 * ツールサーバーへの HTTP リクエストを処理する純粋ハンドラ（テストからも直接呼び出せる）。
 */
export async function handleToolRequest(
  req: Request,
  ctx: ToolRequestContext,
): Promise<Response> {
  const url = new URL(req.url);
  const match = /^\/tool\/([^/]+)$/.exec(url.pathname);
  if (req.method !== 'POST' || !match) {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  }

  if (!verifyBearerToken(req.headers.get('authorization'), ctx.token)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const toolName = decodeURIComponent(match[1]!);
  const handler = Object.hasOwn(TOOL_HANDLERS, toolName) ? TOOL_HANDLERS[toolName] : undefined;
  if (!handler) {
    return Response.json({ ok: false, error: `unknown tool: ${toolName}` }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return Response.json({ ok: false, error: 'request body must be a JSON object' }, { status: 400 });
  }

  const checked = handler(ctx, body as Record<string, unknown>);
  if (!checked.ok) {
    return Response.json({ ok: false, error: checked.error }, { status: 400 });
  }

  try {
    const result = await checked.exec();
    return Response.json({ ok: true, result }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 200 });
  }
}

/**
 * webhook モード用ローカル HTTP ツールサーバーを起動し、接続情報を {stateDir}/tool-server.json に書き出す。
 */
export function startToolServer(opts: {
  tools: DiscordTools;
  stateDir: string;
  workspace: string;
  getConfig: () => BotConfig;
}): { port: number; stop(): void } {
  const token = randomBytes(32).toString('hex');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      return handleToolRequest(req, {
        tools: opts.tools,
        token,
        workspace: opts.workspace,
        getConfig: opts.getConfig,
      });
    },
  });

  const port = server.port;
  if (port === undefined) {
    void server.stop(true);
    throw new Error('ツールサーバーのポート取得に失敗しました');
  }

  const infoPath = join(opts.stateDir, 'tool-server.json');
  const tmpPath = join(opts.stateDir, 'tool-server.json.tmp');
  try {
    mkdirSync(opts.stateDir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify({ port, token, pid: process.pid }, null, 2), 'utf8');
    renameSync(tmpPath, infoPath);
  } catch (err) {
    void server.stop(true);
    throw err;
  }

  let stopped = false;
  return {
    port,
    stop(): void {
      if (stopped) return;
      stopped = true;
      void server.stop(true);
      try {
        unlinkSync(infoPath);
      } catch {
        // 既に削除済みなら無視する
      }
    },
  };
}
