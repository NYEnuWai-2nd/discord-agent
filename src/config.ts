import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/** このリポジトリのルートディレクトリ（import.meta.url 基準） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** JST (Asia/Tokyo) の [HH:MM:SS] タイムスタンプを返す */
function jstPrefix(): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
  return `[${time}]`;
}

/** チャンネル単位の受信ポリシー */
export type ChannelPolicy = { requireMention?: boolean; allowFrom?: string[] };

/** ボット設定 */
export type BotConfig = {
  channels: Record<string, ChannelPolicy>;
  dmAllowFrom: string[];
  allowBots: string[];
  mentionPatterns: string[];
  ackReaction?: string;
  replyToMode: 'off' | 'first' | 'all';
  chunkMode: 'length' | 'newline';
  textChunkLimit: number;
  patrolChannels?: string[];
  modeAdmins: string[];
};

const channelPolicySchema = z.object({
  requireMention: z.boolean().default(true),
  allowFrom: z.array(z.string()).default([]),
});

const botConfigSchema = z.object({
  channels: z.record(z.string(), channelPolicySchema).default({}),
  dmAllowFrom: z.array(z.string()).default([]),
  allowBots: z.array(z.string()).default([]),
  mentionPatterns: z.array(z.string()).default([]),
  ackReaction: z.string().optional(),
  replyToMode: z.enum(['off', 'first', 'all']).default('first'),
  chunkMode: z.enum(['length', 'newline']).default('newline'),
  textChunkLimit: z
    .number()
    .finite()
    .default(2000)
    .transform((n) => Math.min(2000, Math.max(1, Math.trunc(n)))),
  patrolChannels: z.array(z.string()).default([]),
  modeAdmins: z.array(z.string()).default([]),
});

/**
 * 設定オブジェクトを検証し、欠けた項目に既定値を埋めて返す。
 * 型が違う値がある場合は項目名を含む Error を投げる。
 */
export function parseConfig(raw: unknown): BotConfig {
  const result = botConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`Invalid config: ${details}`);
  }
  return result.data;
}

/**
 * Claude Code の Discord プラグイン用 access.json を BotConfig 形式に変換する。
 */
export function convertAccessJson(raw: unknown): BotConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid access.json: root must be an object');
  }
  const obj = raw as Record<string, unknown>;

  const channels: Record<string, unknown> = {};
  if (obj.groups !== undefined) {
    if (typeof obj.groups !== 'object' || obj.groups === null || Array.isArray(obj.groups)) {
      throw new Error('Invalid access.json: groups must be an object');
    }
    for (const [id, entry] of Object.entries(obj.groups as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`Invalid access.json: groups.${id} must be an object`);
      }
      const record = entry as Record<string, unknown>;
      // requireMention か allowFrom を持つエントリだけを取り込む（channels 配列のみのサーバー単位メモは捨てる）
      const hasRequireMention =
        Object.hasOwn(record, 'requireMention') && record.requireMention !== undefined;
      const hasAllowFrom = Object.hasOwn(record, 'allowFrom') && record.allowFrom !== undefined;
      if (hasRequireMention || hasAllowFrom) {
        channels[id] = entry;
      }
    }
  }

  const mapped: Record<string, unknown> = {
    channels,
    chunkMode: obj.chunkMode ?? 'newline',
  };
  if (obj.allowFrom !== undefined) mapped.dmAllowFrom = obj.allowFrom;
  if (obj.allowBots !== undefined) mapped.allowBots = obj.allowBots;
  if (obj.mentionPatterns !== undefined) mapped.mentionPatterns = obj.mentionPatterns;
  if (obj.ackReaction !== undefined) mapped.ackReaction = obj.ackReaction;
  if (obj.replyToMode !== undefined) mapped.replyToMode = obj.replyToMode;
  if (obj.textChunkLimit !== undefined) mapped.textChunkLimit = obj.textChunkLimit;

  return parseConfig(mapped);
}

type CachedConfig = {
  mtimeMs: number;
  config: BotConfig;
};

const configCache = new Map<string, CachedConfig>();
const warnedMissingPaths = new Set<string>();

/**
 * 設定ファイルを読み込む。mtime が前回と同じ場合はキャッシュを返す。
 * ファイルが存在しない場合は 1 回だけ警告を出して空設定を返す。
 */
export function loadConfig(path: string): BotConfig {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (!warnedMissingPaths.has(path)) {
        warnedMissingPaths.add(path);
        console.error(`${jstPrefix()} 警告: 設定ファイルが見つかりません (${path})。空の設定で続行します。`);
      }
      return parseConfig({});
    }
    throw err;
  }

  const cached = configCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.config;
  }

  try {
    const rawText = readFileSync(path, 'utf8');
    const parsedJson: unknown = JSON.parse(rawText);
    const config = parseConfig(parsedJson);
    configCache.set(path, { mtimeMs, config });
    warnedMissingPaths.delete(path);
    return config;
  } catch (err) {
    if (cached) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${jstPrefix()} 警告: 設定ファイルの読み込みに失敗したため前回の設定を維持します (${path}): ${msg}`);
      return cached.config;
    }
    throw err;
  }
}

/** 解決済みの環境変数 */
export type Env = {
  token: string;
  workspace: string;
  model?: string;
  permissionMode: PermissionMode;
  stateDir: string;
  configPath: string;
  fresh: boolean;
  patrolMinutes: number;
};

/** 頭脳モード */
export type BrainKind = 'claude' | 'webhook' | 'acp';

/** ACP モード用の解決済み設定 */
export type AcpEnv = {
  command: string;
  cwd: string;
  instructionsPath: string;
  model?: string;
  promptTimeoutSec: number;
  maxTurns: number;
};

const VALID_PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];

/**
 * 環境変数を検証・解決して返す。
 */
export function loadEnv(env: Record<string, string | undefined> = process.env): Env {
  const token = env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN is required');
  }

  const rawWorkspace = env.BOT_WORKSPACE?.trim();
  if (!rawWorkspace) {
    throw new Error('BOT_WORKSPACE is required');
  }
  const workspace = resolve(rawWorkspace);
  let isDir = false;
  try {
    isDir = statSync(workspace).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(`BOT_WORKSPACE is not an existing directory: ${workspace}`);
  }

  const rawMode = env.BOT_PERMISSION_MODE?.trim();
  const permissionMode: PermissionMode = (rawMode || 'bypassPermissions') as PermissionMode;
  if (!VALID_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(
      `Invalid BOT_PERMISSION_MODE "${permissionMode}". Expected one of: ${VALID_PERMISSION_MODES.join(', ')}`,
    );
  }

  const rawStateDir = env.BOT_STATE_DIR?.trim();
  const stateDir = rawStateDir ? resolve(REPO_ROOT, rawStateDir) : resolve(REPO_ROOT, '.state');

  const rawConfigPath = env.BOT_CONFIG?.trim();
  const configPath = rawConfigPath ? resolve(REPO_ROOT, rawConfigPath) : resolve(REPO_ROOT, 'config.json');

  const model = env.BOT_MODEL?.trim() || undefined;
  const fresh = env.BOT_FRESH_SESSION === '1';

  const rawPatrolMinutes = env.BOT_PATROL_MINUTES?.trim();
  let patrolMinutes = 0;
  if (rawPatrolMinutes && rawPatrolMinutes !== '0') {
    const parsed = Number(rawPatrolMinutes);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid BOT_PATROL_MINUTES "${rawPatrolMinutes}": must be a number`);
    }
    if (parsed < 1) {
      throw new Error(`Invalid BOT_PATROL_MINUTES "${rawPatrolMinutes}": must be 0 or >= 1`);
    }
    patrolMinutes = parsed;
  }

  return {
    token,
    workspace,
    ...(model !== undefined ? { model } : {}),
    permissionMode,
    stateDir,
    configPath,
    fresh,
    patrolMinutes,
  };
}

/**
 * BOT_BRAIN の値を解決する（省略時は 'claude'）。
 */
export function resolveBrainKind(env: Record<string, string | undefined> = process.env): BrainKind {
  const raw = env.BOT_BRAIN?.trim() || 'claude';
  if (raw === 'claude' || raw === 'webhook' || raw === 'acp') {
    return raw;
  }
  throw new Error(`Invalid BOT_BRAIN "${raw}". Expected one of: claude, webhook, acp`);
}

/**
 * BOT_BRAIN=acp 用の環境変数を検証・解決して返す。
 */
export function loadAcpEnv(
  workspace: string,
  env: Record<string, string | undefined> = process.env,
): AcpEnv {
  const command = env.BOT_ACP_COMMAND?.trim();
  if (!command) {
    throw new Error('BOT_BRAIN=acp には BOT_ACP_COMMAND が必要です');
  }

  const rawCwd = env.BOT_ACP_CWD?.trim();
  const cwd = rawCwd ? resolve(REPO_ROOT, rawCwd) : workspace;
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(`BOT_ACP_CWD is not an existing directory: ${cwd}`);
  }

  const rawInstructions = env.BOT_ACP_INSTRUCTIONS?.trim();
  const instructionsPath = (
    rawInstructions ? resolve(REPO_ROOT, rawInstructions) : resolve(REPO_ROOT, 'GEMINI_BRAIN.md')
  ).replace(/\\/g, '/');

  const model = env.BOT_ACP_MODEL?.trim() || undefined;

  let promptTimeoutSec = 300;
  const rawTimeout = env.BOT_ACP_PROMPT_TIMEOUT_SEC?.trim();
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid BOT_ACP_PROMPT_TIMEOUT_SEC "${rawTimeout}": must be > 0`);
    }
    promptTimeoutSec = parsed;
  }

  let maxTurns = 200;
  const rawMaxTurns = env.BOT_ACP_MAX_TURNS?.trim();
  if (rawMaxTurns) {
    const parsed = Number(rawMaxTurns);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`Invalid BOT_ACP_MAX_TURNS "${rawMaxTurns}": must be an integer >= 1`);
    }
    maxTurns = parsed;
  }

  return {
    command,
    cwd,
    instructionsPath,
    ...(model !== undefined ? { model } : {}),
    promptTimeoutSec,
    maxTurns,
  };
}
