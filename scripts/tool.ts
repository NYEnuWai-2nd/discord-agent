/**
 * 常駐中の bot（BOT_BRAIN=webhook）のローカルツールサーバー経由で Discord ツールを実行する CLI。
 *
 *   bun scripts/tool.ts <tool_name> --key value ...
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONNECT_ERROR_MESSAGE =
  'bot のツールサーバーに繋がりません（bot が webhook モードで動いているか確認）';
const BANNED = new RegExp('(?<![a-z0-9_])' + 'us' + 'er' + 's?(?![a-z0-9_])', 'i');

export const HELP_TEXT = [
  '使い方: bun scripts/tool.ts <tool_name> --key value ...',
  '',
  '利用可能なツール:',
  '  reply                --chat_id <id> --text <text> [--reply_to <id>] [--files <path> ...] [--text-file <path>]',
  '  react                --chat_id <id> --message_id <id> --emoji <emoji>',
  '  edit_message         --chat_id <id> --message_id <id> --text <text> [--text-file <path>]',
  '  download_attachment  --chat_id <id> --message_id <id>',
  '  fetch_messages       --channel <id> [--limit <n>]',
  '  list_members         --channel <id> [--user_id <id>] [--limit <n>]',
  '  set_state            --chat_id <id> --message_id <id> --key <key> --value <value>',
  '  add_person           --name <name> --user_id <id|不明> --description <text>',
  '  note_person          --user_id <id> --note <text>',
].join('\n');

/**
 * コマンドライン引数をツール名と引数オブジェクトに分解する。
 * 最初の位置引数をツール名とし、--files は配列、limit は数値、それ以外は文字列として扱う。
 */
export function parseToolArgs(argv: string[]): { name: string; args: Record<string, unknown> } {
  let name: string | undefined;
  const args: Record<string, unknown> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      if (name === undefined) {
        name = token;
      } else {
        throw new Error(`余分な引数です: ${token}`);
      }
      continue;
    }

    const key = token.slice(2);
    if (!key) {
      throw new Error('空のフラグ名です: --');
    }
    if (i + 1 >= argv.length) {
      throw new Error(`--${key} の値がありません`);
    }
    const value = argv[++i]!;

    if (key === 'files') {
      const current = args.files;
      if (Array.isArray(current)) {
        current.push(value);
      } else {
        args.files = [value];
      }
    } else if (key === 'limit') {
      if (value.trim() === '') {
        throw new Error(`--limit は数値である必要があります: ${value}`);
      }
      const num = Number(value);
      if (!Number.isFinite(num)) {
        throw new Error(`--limit は数値である必要があります: ${value}`);
      }
      args.limit = num;
    } else if (key === 'text-file') {
      args.text = readFileSync(resolve(value), 'utf8');
    } else {
      args[key] = value;
    }
  }

  if (!name) {
    throw new Error('ツール名を指定してください');
  }

  return { name, args };
}

function fail(msg: string): never {
  console.error(`tool failed: ${msg}`);
  process.exit(1);
}

function resolveStateDir(): string {
  // take.ts と同様に、環境変数またはこのリポジトリの .env から BOT_STATE_DIR だけ読む
  let stateDirSetting = process.env.BOT_STATE_DIR;
  if (stateDirSetting === undefined) {
    try {
      const m = /^BOT_STATE_DIR=(.*)$/m.exec(readFileSync(join(REPO_ROOT, '.env'), 'utf8'));
      if (m && m[1]!.trim()) stateDirSetting = m[1]!.trim();
    } catch {
      // .env が無ければ既定値
    }
  }
  return resolve(REPO_ROOT, stateDirSetting || '.state');
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes('--help') || rawArgv.includes('-h')) {
    console.log(HELP_TEXT);
    return;
  }

  let parsed: { name: string; args: Record<string, unknown> };
  try {
    parsed = parseToolArgs(rawArgv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (rawArgv.length === 0) {
      console.error(HELP_TEXT);
    }
    fail(msg);
  }

  const { name, args } = parsed;
  if ((name === 'reply' || name === 'edit_message') && typeof args.text === 'string') {
    if (BANNED.test(args.text)) {
      fail('本文に禁止語が含まれています。日本語（利用者など）に言い換えてください');
    }
  }

  const stateDir = resolveStateDir();
  let serverInfo: { port?: unknown; token?: unknown };
  try {
    serverInfo = JSON.parse(readFileSync(join(stateDir, 'tool-server.json'), 'utf8')) as {
      port?: unknown;
      token?: unknown;
    };
  } catch {
    fail(CONNECT_ERROR_MESSAGE);
  }
  if (typeof serverInfo.port !== 'number' || typeof serverInfo.token !== 'string') {
    fail(CONNECT_ERROR_MESSAGE);
  }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${serverInfo.port}/tool/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serverInfo.token}`,
      },
      body: JSON.stringify(args),
    });
  } catch {
    fail(CONNECT_ERROR_MESSAGE);
  }

  const data = (await res.json().catch(() => null)) as {
    ok?: unknown;
    result?: unknown;
    error?: unknown;
  } | null;

  if (!data || data.ok !== true || typeof data.result !== 'string') {
    const errMsg = data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
    fail(errMsg);
  }

  console.log(data.result);
}

if (import.meta.main) {
  void main();
}
