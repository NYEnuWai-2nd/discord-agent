import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../src/acp-client.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFallback(key: string): string | undefined {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(raw);
    const val = m?.[1]?.trim();
    return val ? val.replace(/^['"]|['"]$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const command = readEnvFallback('BOT_ACP_COMMAND');
  if (!command) {
    throw new Error('BOT_ACP_COMMAND を指定してください');
  }
  const model = readEnvFallback('BOT_ACP_MODEL');
  const cwd = readEnvFallback('BOT_ACP_CWD') ?? readEnvFallback('BOT_WORKSPACE') ?? REPO_ROOT;
  const stateDir = mkdtempSync(join(tmpdir(), 'acp-smoke-'));

  const client = new AcpClient({
    command,
    cwd,
    stateDir,
    model,
    fresh: true,
    log: (msg) => console.log(`[smoke] ${msg}`),
  });

  try {
    const started = await client.start();
    console.log(`[smoke] started sessionId=${started.sessionId} isNew=${started.isNewSession}`);
    const res = await client.prompt('こんにちは とだけ返して');
    console.log(`[smoke] stopReason=${res.stopReason} usedTokens=${client.lastUsedTokens ?? 'n/a'}`);
    if (res.stopReason !== 'end_turn') {
      throw new Error(`unexpected stopReason: ${res.stopReason}`);
    }
  } finally {
    client.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

void main().catch((err) => {
  console.error('ACP スモークチェック失敗:', err);
  process.exit(1);
});
