import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  convertAccessJson,
  loadAcpEnv,
  loadConfig,
  loadEnv,
  parseConfig,
  resolveBrainKind,
} from '../src/config.ts'

const tempDirs: string[] = []

function makeTempDir(prefix = 'discord-agent-config-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseConfig', () => {
  test('空オブジェクトに既定値を入れる', () => {
    const cfg = parseConfig({})
    expect(cfg).toEqual({
      channels: {},
      dmAllowFrom: [],
      allowBots: [],
      mentionPatterns: [],
      replyToMode: 'first',
      chunkMode: 'newline',
      textChunkLimit: 2000,
      patrolChannels: [],
      modeAdmins: [],
    })
    expect(cfg.ackReaction).toBeUndefined()
  })

  test('各 ChannelPolicy の省略時既定値（requireMention: true, allowFrom: []）を埋める', () => {
    const cfg = parseConfig({
      channels: {
        c1: {},
        c2: { requireMention: false },
        c3: { allowFrom: ['u1'] },
        c4: { requireMention: true, allowFrom: ['u2', 'u3'] },
      },
    })
    expect(cfg.channels).toEqual({
      c1: { requireMention: true, allowFrom: [] },
      c2: { requireMention: false, allowFrom: [] },
      c3: { requireMention: true, allowFrom: ['u1'] },
      c4: { requireMention: true, allowFrom: ['u2', 'u3'] },
    })
  })

  test('明示した全項目を保持する', () => {
    const cfg = parseConfig({
      channels: { c1: { requireMention: false, allowFrom: ['u1'] } },
      dmAllowFrom: ['dm1'],
      allowBots: ['bot1'],
      mentionPatterns: ['^hey'],
      ackReaction: '👀',
      replyToMode: 'all',
      chunkMode: 'length',
      textChunkLimit: 1500,
      patrolChannels: ['c1'],
      modeAdmins: ['admin1', 'admin2'],
    })
    expect(cfg).toEqual({
      channels: { c1: { requireMention: false, allowFrom: ['u1'] } },
      dmAllowFrom: ['dm1'],
      allowBots: ['bot1'],
      mentionPatterns: ['^hey'],
      ackReaction: '👀',
      replyToMode: 'all',
      chunkMode: 'length',
      textChunkLimit: 1500,
      patrolChannels: ['c1'],
      modeAdmins: ['admin1', 'admin2'],
    })
  })

  test('textChunkLimit を 1〜2000 の範囲に丸める', () => {
    expect(parseConfig({ textChunkLimit: 0 }).textChunkLimit).toBe(1)
    expect(parseConfig({ textChunkLimit: -50 }).textChunkLimit).toBe(1)
    expect(parseConfig({ textChunkLimit: 1 }).textChunkLimit).toBe(1)
    expect(parseConfig({ textChunkLimit: 2000 }).textChunkLimit).toBe(2000)
    expect(parseConfig({ textChunkLimit: 9999 }).textChunkLimit).toBe(2000)
  })

  test('未知のキーは無視する', () => {
    const cfg = parseConfig({
      unknownTopLevel: 'ignored',
      another: 42,
      channels: {
        c1: { requireMention: false, unknownNested: true },
      },
    })
    expect(cfg.channels.c1).toEqual({ requireMention: false, allowFrom: [] })
    expect('unknownTopLevel' in cfg).toBe(false)
  })

  test('型が違う値があれば項目名を含む Error を投げる', () => {
    expect(() => parseConfig({ dmAllowFrom: 'not-array' })).toThrow(/dmAllowFrom/)
    expect(() => parseConfig({ allowBots: [123] })).toThrow(/allowBots/)
    expect(() => parseConfig({ mentionPatterns: 99 })).toThrow(/mentionPatterns/)
    expect(() => parseConfig({ replyToMode: 'sometimes' })).toThrow(/replyToMode/)
    expect(() => parseConfig({ chunkMode: 'word' })).toThrow(/chunkMode/)
    expect(() => parseConfig({ textChunkLimit: '2000' })).toThrow(/textChunkLimit/)
    expect(() => parseConfig({ ackReaction: 123 })).toThrow(/ackReaction/)
    expect(() => parseConfig({ patrolChannels: 'c1' })).toThrow(/patrolChannels/)
    expect(() => parseConfig({ patrolChannels: [123] })).toThrow(/patrolChannels/)
    expect(() => parseConfig({ modeAdmins: 'admin1' })).toThrow(/modeAdmins/)
    expect(() => parseConfig({ modeAdmins: [123] })).toThrow(/modeAdmins/)
    expect(() => parseConfig({ channels: { c1: { requireMention: 'yes' } } })).toThrow(
      /channels|requireMention/,
    )
    expect(() => parseConfig(null)).toThrow()
  })
})

describe('convertAccessJson', () => {
  test('groups の選別・allowFrom→dmAllowFrom・各項目コピー・既定 chunkMode を行う', () => {
    const raw = {
      dmPolicy: 'pairing',
      pending: { abc: { id: 'p1' } },
      allowFrom: ['dm1', 'dm2'],
      allowBots: ['bot1'],
      mentionPatterns: ['claude'],
      ackReaction: '👀',
      replyToMode: 'all',
      textChunkLimit: 1800,
      groups: {
        'guild-memo': { channels: ['ch1', 'ch2'] },
        'empty-memo': {},
        ch1: { requireMention: false },
        ch2: { allowFrom: ['u1'] },
        ch3: { requireMention: true, allowFrom: ['u2'], extraField: 'drop' },
      },
    }

    const cfg = convertAccessJson(raw)
    expect(cfg).toEqual({
      channels: {
        ch1: { requireMention: false, allowFrom: [] },
        ch2: { requireMention: true, allowFrom: ['u1'] },
        ch3: { requireMention: true, allowFrom: ['u2'] },
      },
      dmAllowFrom: ['dm1', 'dm2'],
      allowBots: ['bot1'],
      mentionPatterns: ['claude'],
      ackReaction: '👀',
      replyToMode: 'all',
      chunkMode: 'newline',
      textChunkLimit: 1800,
      patrolChannels: [],
      modeAdmins: [],
    })
    expect('dmPolicy' in cfg).toBe(false)
    expect('pending' in cfg).toBe(false)
  })

  test('chunkMode が明示されていればそのまま移す', () => {
    const cfg = convertAccessJson({ chunkMode: 'length' })
    expect(cfg.chunkMode).toBe('length')
  })

  test('空のオブジェクトでも parseConfig 相当の既定値を返す', () => {
    expect(convertAccessJson({})).toEqual(parseConfig({}))
  })
})

describe('loadConfig', () => {
  test('壊れた JSON で前回正常に読めた値がなければ Error を投げる', () => {
    const dir = makeTempDir()
    const noPrior = path.join(dir, 'no-prior.json')
    fs.writeFileSync(noPrior, '{ broken json', 'utf8')
    expect(() => loadConfig(noPrior)).toThrow()
  })

  test('ファイルがなければ空設定（parseConfig({}) 相当）を返す', () => {
    const dir = makeTempDir()
    const missing = path.join(dir, 'does-not-exist.json')
    expect(loadConfig(missing)).toEqual(parseConfig({}))
    // 2 回目も例外を出さずに同じ結果を返す
    expect(loadConfig(missing)).toEqual(parseConfig({}))
  })

  test('mtime が同じならキャッシュを返し、mtime が変わったら読み直す', () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'config.json')
    const baseSec = Math.floor(Date.now() / 1000) * 1000 - 10_000
    const t1 = new Date(baseSec)
    const t2 = new Date(baseSec + 5000)

    fs.writeFileSync(file, JSON.stringify({ replyToMode: 'off' }), 'utf8')
    fs.utimesSync(file, t1, t1)
    expect(loadConfig(file).replyToMode).toBe('off')

    // 中身を書き換えても mtime を同じに戻せばキャッシュが返る
    fs.writeFileSync(file, JSON.stringify({ replyToMode: 'all' }), 'utf8')
    fs.utimesSync(file, t1, t1)
    expect(loadConfig(file).replyToMode).toBe('off')

    // mtime を更新すれば再読み込みされる
    fs.utimesSync(file, t2, t2)
    expect(loadConfig(file).replyToMode).toBe('all')
  })

  test('壊れた JSON でも前回正常に読めた値があればフォールバックする', () => {
    const dir = makeTempDir()
    const baseSec = Math.floor(Date.now() / 1000) * 1000 - 10_000
    const t1 = new Date(baseSec)
    const t2 = new Date(baseSec + 5000)

    const withPrior = path.join(dir, 'with-prior.json')
    fs.writeFileSync(withPrior, JSON.stringify({ dmAllowFrom: ['u-ok'] }), 'utf8')
    fs.utimesSync(withPrior, t1, t1)
    expect(loadConfig(withPrior).dmAllowFrom).toEqual(['u-ok'])

    fs.writeFileSync(withPrior, '{ broken json', 'utf8')
    fs.utimesSync(withPrior, t2, t2)
    expect(loadConfig(withPrior).dmAllowFrom).toEqual(['u-ok'])
  })
})

describe('loadEnv', () => {
  test('必須項目のみで既定値が正しく解決される', () => {
    const workspaceDir = makeTempDir('discord-agent-ws-')
    const env = loadEnv({
      DISCORD_BOT_TOKEN: 'secret-token',
      BOT_WORKSPACE: workspaceDir,
    })

    expect(env.token).toBe('secret-token')
    expect(path.isAbsolute(env.workspace)).toBe(true)
    expect(env.workspace).toBe(path.resolve(workspaceDir))
    expect(env.model).toBeUndefined()
    expect(env.permissionMode).toBe('bypassPermissions')
    expect(env.fresh).toBe(false)
    expect(env.patrolMinutes).toBe(0)
    expect(path.isAbsolute(env.stateDir)).toBe(true)
    expect(env.stateDir.endsWith('.state')).toBe(true)
    expect(path.isAbsolute(env.configPath)).toBe(true)
    expect(env.configPath.endsWith('config.json')).toBe(true)
  })

  test('DISCORD_BOT_TOKEN が未設定または空なら Error', () => {
    const workspaceDir = makeTempDir('discord-agent-ws-')
    expect(() => loadEnv({ BOT_WORKSPACE: workspaceDir })).toThrow()
    expect(() => loadEnv({ DISCORD_BOT_TOKEN: '', BOT_WORKSPACE: workspaceDir })).toThrow()
  })

  test('BOT_WORKSPACE が未設定・存在しないパス・ファイルの場合は Error', () => {
    const dir = makeTempDir('discord-agent-ws-')
    const filePath = path.join(dir, 'not-a-dir.txt')
    fs.writeFileSync(filePath, 'hi', 'utf8')

    expect(() => loadEnv({ DISCORD_BOT_TOKEN: 'tok' })).toThrow()
    expect(() =>
      loadEnv({ DISCORD_BOT_TOKEN: 'tok', BOT_WORKSPACE: path.join(dir, 'missing') }),
    ).toThrow()
    expect(() => loadEnv({ DISCORD_BOT_TOKEN: 'tok', BOT_WORKSPACE: filePath })).toThrow()
  })

  test('BOT_PERMISSION_MODE は有効な SDK PermissionMode のみ許可し、不正値は Error', () => {
    const workspaceDir = makeTempDir('discord-agent-ws-')
    const validModes = [
      'default',
      'acceptEdits',
      'bypassPermissions',
      'plan',
      'dontAsk',
      'auto',
    ] as const

    for (const mode of validModes) {
      const env = loadEnv({
        DISCORD_BOT_TOKEN: 'tok',
        BOT_WORKSPACE: workspaceDir,
        BOT_PERMISSION_MODE: mode,
      })
      expect(env.permissionMode).toBe(mode)
    }

    expect(() =>
      loadEnv({
        DISCORD_BOT_TOKEN: 'tok',
        BOT_WORKSPACE: workspaceDir,
        BOT_PERMISSION_MODE: 'invalidMode',
      }),
    ).toThrow()
  })

  test('BOT_FRESH_SESSION が "1" のときだけ fresh: true になる', () => {
    const workspaceDir = makeTempDir('discord-agent-ws-')
    expect(
      loadEnv({
        DISCORD_BOT_TOKEN: 'tok',
        BOT_WORKSPACE: workspaceDir,
        BOT_FRESH_SESSION: '1',
      }).fresh,
    ).toBe(true)
    expect(
      loadEnv({
        DISCORD_BOT_TOKEN: 'tok',
        BOT_WORKSPACE: workspaceDir,
        BOT_FRESH_SESSION: '0',
      }).fresh,
    ).toBe(false)
    expect(
      loadEnv({
        DISCORD_BOT_TOKEN: 'tok',
        BOT_WORKSPACE: workspaceDir,
        BOT_FRESH_SESSION: 'true',
      }).fresh,
    ).toBe(false)
  })

  test('BOT_MODEL・BOT_STATE_DIR・BOT_CONFIG の指定を反映する', () => {
    const workspaceDir = makeTempDir('discord-agent-ws-')
    const customState = path.join(workspaceDir, 'my-state')
    const customConfig = path.join(workspaceDir, 'my-config.json')

    const absEnv = loadEnv({
      DISCORD_BOT_TOKEN: 'tok',
      BOT_WORKSPACE: workspaceDir,
      BOT_MODEL: 'claude-sonnet-4-6',
      BOT_STATE_DIR: customState,
      BOT_CONFIG: customConfig,
    })
    expect(absEnv.model).toBe('claude-sonnet-4-6')
    expect(absEnv.stateDir).toBe(path.resolve(customState))
    expect(absEnv.configPath).toBe(path.resolve(customConfig))

    const relEnv = loadEnv({
      DISCORD_BOT_TOKEN: 'tok',
      BOT_WORKSPACE: workspaceDir,
      BOT_STATE_DIR: 'rel-state',
      BOT_CONFIG: 'rel-config.json',
    })
    expect(path.isAbsolute(relEnv.stateDir)).toBe(true)
    expect(relEnv.stateDir.endsWith(`${path.sep}rel-state`)).toBe(true)
    expect(path.isAbsolute(relEnv.configPath)).toBe(true)
    expect(relEnv.configPath.endsWith(`${path.sep}rel-config.json`)).toBe(true)
  })

  test('BOT_PATROL_MINUTES の解決と境界・不正値エラー', () => {
    const workspaceDir = makeTempDir('discord-agent-ws-')

    // 未設定・空・'0' は 0（無効）
    expect(loadEnv({ DISCORD_BOT_TOKEN: 'tok', BOT_WORKSPACE: workspaceDir }).patrolMinutes).toBe(0)
    expect(
      loadEnv({ DISCORD_BOT_TOKEN: 'tok', BOT_WORKSPACE: workspaceDir, BOT_PATROL_MINUTES: '' })
        .patrolMinutes,
    ).toBe(0)
    expect(
      loadEnv({ DISCORD_BOT_TOKEN: 'tok', BOT_WORKSPACE: workspaceDir, BOT_PATROL_MINUTES: '   ' })
        .patrolMinutes,
    ).toBe(0)
    expect(
      loadEnv({ DISCORD_BOT_TOKEN: 'tok', BOT_WORKSPACE: workspaceDir, BOT_PATROL_MINUTES: '0' })
        .patrolMinutes,
    ).toBe(0)

    // 1 以上は数値として受け付ける
    expect(
      loadEnv({ DISCORD_BOT_TOKEN: 'tok', BOT_WORKSPACE: workspaceDir, BOT_PATROL_MINUTES: '1' })
        .patrolMinutes,
    ).toBe(1)
    expect(
      loadEnv({ DISCORD_BOT_TOKEN: 'tok', BOT_WORKSPACE: workspaceDir, BOT_PATROL_MINUTES: '15' })
        .patrolMinutes,
    ).toBe(15)

    // 1 未満・非数値は Error
    for (const bad of ['0.5', '-1', 'abc', 'Infinity', 'NaN']) {
      expect(() =>
        loadEnv({
          DISCORD_BOT_TOKEN: 'tok',
          BOT_WORKSPACE: workspaceDir,
          BOT_PATROL_MINUTES: bad,
        }),
      ).toThrow(/BOT_PATROL_MINUTES/)
    }
  })
})

describe('resolveBrainKind / loadAcpEnv', () => {
  test('BOT_BRAIN の解決と不正値エラー', () => {
    expect(resolveBrainKind({})).toBe('claude')
    expect(resolveBrainKind({ BOT_BRAIN: 'webhook' })).toBe('webhook')
    expect(resolveBrainKind({ BOT_BRAIN: 'acp' })).toBe('acp')
    expect(() => resolveBrainKind({ BOT_BRAIN: 'unknown' })).toThrow(/BOT_BRAIN/)
  })

  test('loadAcpEnv の必須チェックと既定値・境界チェック', () => {
    const workspaceDir = makeTempDir('discord-agent-acp-ws-')
    expect(() => loadAcpEnv(workspaceDir, {})).toThrow(/BOT_ACP_COMMAND/)

    const cfg = loadAcpEnv(workspaceDir, { BOT_ACP_COMMAND: 'agy acp' })
    expect(cfg.command).toBe('agy acp')
    expect(cfg.cwd).toBe(workspaceDir)
    expect(cfg.instructionsPath.endsWith('/GEMINI_BRAIN.md')).toBe(true)
    expect(cfg.instructionsPath.includes('\\')).toBe(false)
    expect(cfg.model).toBeUndefined()
    expect(cfg.promptTimeoutSec).toBe(300)
    expect(cfg.maxTurns).toBe(200)

    const custom = loadAcpEnv(workspaceDir, {
      BOT_ACP_COMMAND: 'gemini --experimental-acp',
      BOT_ACP_CWD: workspaceDir,
      BOT_ACP_MODEL: 'gemini-2.5-pro',
      BOT_ACP_PROMPT_TIMEOUT_SEC: '120',
      BOT_ACP_MAX_TURNS: '50',
    })
    expect(custom.model).toBe('gemini-2.5-pro')
    expect(custom.promptTimeoutSec).toBe(120)
    expect(custom.maxTurns).toBe(50)

    expect(() =>
      loadAcpEnv(workspaceDir, {
        BOT_ACP_COMMAND: 'agy acp',
        BOT_ACP_PROMPT_TIMEOUT_SEC: '0',
      }),
    ).toThrow(/BOT_ACP_PROMPT_TIMEOUT_SEC/)

    expect(() =>
      loadAcpEnv(workspaceDir, {
        BOT_ACP_COMMAND: 'agy acp',
        BOT_ACP_MAX_TURNS: '1.5',
      }),
    ).toThrow(/BOT_ACP_MAX_TURNS/)
  })
})
