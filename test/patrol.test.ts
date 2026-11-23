import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BotConfig } from '../src/config.ts'
import { hasPendingPatrol, selectChanged, startPatrol, type MsgLite } from '../src/patrol.ts'

const tempDirs: string[] = []

function makeTempDir(prefix = 'discord-agent-patrol-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    channels: {},
    dmAllowFrom: [],
    allowBots: [],
    mentionPatterns: [],
    replyToMode: 'first',
    chunkMode: 'newline',
    textChunkLimit: 2000,
    patrolChannels: [],
    modeAdmins: [],
    ...overrides,
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('selectChanged', () => {
  test('初回観測（lastSeen に無いチャンネル）は changed に含めず、最新 ID だけ記録する', () => {
    const lastSeen = new Map<string, string>()
    const snapshot = new Map<string, MsgLite[]>([
      [
        'ch-1',
        [
          { id: '100', authorId: 'u1', isSelf: false },
          { id: '105', authorId: 'u2', isSelf: false },
          { id: '102', authorId: 'u1', isSelf: false },
        ],
      ],
    ])

    const res = selectChanged(lastSeen, snapshot, new Set())
    expect(res.changed).toEqual([])
    expect(res.nextLastSeen.get('ch-1')).toBe('105')
  })

  test('他人の新着メッセージがあれば changed に含まれる', () => {
    const lastSeen = new Map<string, string>([['ch-1', '100']])
    const snapshot = new Map<string, MsgLite[]>([
      [
        'ch-1',
        [
          { id: '100', authorId: 'u1', isSelf: false },
          { id: '101', authorId: 'u2', isSelf: false },
        ],
      ],
    ])

    const res = selectChanged(lastSeen, snapshot, new Set())
    expect(res.changed).toEqual(['ch-1'])
    expect(res.nextLastSeen.get('ch-1')).toBe('101')
  })

  test('自分の発言のみが増えた場合は changed に含まれない', () => {
    const lastSeen = new Map<string, string>([['ch-1', '100']])
    const snapshot = new Map<string, MsgLite[]>([
      [
        'ch-1',
        [
          { id: '100', authorId: 'u1', isSelf: false },
          { id: '102', authorId: 'self', isSelf: true },
        ],
      ],
    ])

    const res = selectChanged(lastSeen, snapshot, new Set())
    expect(res.changed).toEqual([])
    expect(res.nextLastSeen.get('ch-1')).toBe('102')
  })

  test('handled に含まれるメッセージ ID は無視される', () => {
    const lastSeen = new Map<string, string>([
      ['ch-1', '100'],
      ['ch-2', '200'],
    ])
    const snapshot = new Map<string, MsgLite[]>([
      ['ch-1', [{ id: '105', authorId: 'u1', isSelf: false }]],
      [
        'ch-2',
        [
          { id: '205', authorId: 'u1', isSelf: false },
          { id: '206', authorId: 'u2', isSelf: false },
        ],
      ],
    ])
    const handled = new Set<string>(['105', '205'])

    const res = selectChanged(lastSeen, snapshot, handled)
    expect(res.changed).toEqual(['ch-2'])
    expect(res.nextLastSeen.get('ch-1')).toBe('105')
    expect(res.nextLastSeen.get('ch-2')).toBe('206')
  })

  test('桁数が異なる Snowflake ID を文字列順ではなく BigInt 数値順で比較する', () => {
    // 文字列比較では '1000' < '999' になるため、数値比較なら '1000' > '999' で新着と判定されるべき
    const lastSeen = new Map<string, string>([['ch-1', '999']])
    const snapshot = new Map<string, MsgLite[]>([
      [
        'ch-1',
        [
          { id: '998', authorId: 'u1', isSelf: false },
          { id: '1000', authorId: 'u2', isSelf: false },
          { id: '999', authorId: 'u1', isSelf: false },
        ],
      ],
    ])

    const res = selectChanged(lastSeen, snapshot, new Set())
    expect(res.changed).toEqual(['ch-1'])
    expect(res.nextLastSeen.get('ch-1')).toBe('1000')
  })

  test('空スナップショットは以前の lastSeen を保持し changed に含めない', () => {
    const lastSeen = new Map<string, string>([['ch-1', '500']])
    const snapshot = new Map<string, MsgLite[]>([
      ['ch-1', []],
      ['ch-empty-new', []],
    ])

    const res = selectChanged(lastSeen, snapshot, new Set())
    expect(res.changed).toEqual([])
    expect(res.nextLastSeen.get('ch-1')).toBe('500')
    expect(res.nextLastSeen.has('ch-empty-new')).toBe(false)
  })
})

describe('hasPendingPatrol', () => {
  test('存在しないディレクトリや *-patrol.json が無い場合は false', () => {
    const base = makeTempDir()
    expect(hasPendingPatrol(path.join(base, 'missing'))).toBe(false)

    const pendingDir = path.join(base, 'pending')
    fs.mkdirSync(pendingDir)
    expect(hasPendingPatrol(pendingDir)).toBe(false)

    fs.writeFileSync(path.join(pendingDir, '1700000000000-12345.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(pendingDir, '1700000000000-patrol.json.tmp'), '{}', 'utf8')
    expect(hasPendingPatrol(pendingDir)).toBe(false)
  })

  test('*-patrol.json が存在すれば true', () => {
    const pendingDir = makeTempDir()
    fs.writeFileSync(path.join(pendingDir, '1700000000000-12345.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(pendingDir, '1700000000001-patrol.json'), '{}', 'utf8')
    expect(hasPendingPatrol(pendingDir)).toBe(true)
  })
})

describe('startPatrol', () => {
  test('初回は通知せず観測のみ行い、次 tick で対象チャンネルの新着だけ enqueue する', async () => {
    let calls = 0
    const fetchedChannels: string[] = []
    const enqueued: Array<Array<{ chatId: string; history: string }>> = []
    const logs: string[] = []

    let resolveSecondTick!: () => void
    const secondTickDone = new Promise<void>((resolve) => {
      resolveSecondTick = resolve
    })

    const cfg = makeConfig({
      channels: {
        'ch-a': { requireMention: true },
        'ch-b': { requireMention: true },
      },
      patrolChannels: ['ch-a', 'ch-unlisted'],
    })

    const handle = startPatrol({
      intervalMs: 25,
      getConfig: () => cfg,
      fetchSnapshot: async (channelId) => {
        fetchedChannels.push(channelId)
        calls += 1
        if (calls === 1) {
          return {
            lite: [{ id: '10', authorId: 'u1', isSelf: false }],
            history: 'old line',
          }
        }
        return {
          lite: [
            { id: '10', authorId: 'u1', isSelf: false },
            { id: '11', authorId: 'u2', isSelf: false },
          ],
          history: 'new line',
        }
      },
      handled: new Set(),
      enqueue: async (channels) => {
        enqueued.push(channels)
        resolveSecondTick()
      },
      log: (msg) => {
        logs.push(msg)
      },
    })

    try {
      await Promise.race([
        secondTickDone,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('patrol did not enqueue in time')), 500),
        ),
      ])
    } finally {
      handle.stop()
    }

    // ch-unlisted は channels に無いため除外され、ch-a のみ巡回される
    expect(fetchedChannels.every((c) => c === 'ch-a')).toBe(true)
    expect(enqueued).toEqual([[{ chatId: 'ch-a', history: 'new line' }]])
    expect(logs).toContain('巡回: 1 チャンネルに新着')
  })
})
