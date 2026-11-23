import { describe, expect, test } from 'bun:test'
import type { BotConfig } from '../src/config.ts'
import {
  canSendTo,
  decide,
  matchesMentionPattern,
  type InboundFacts,
  type OutboundTarget,
} from '../src/gate.ts'

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    channels: {},
    dmAllowFrom: [],
    allowBots: [],
    mentionPatterns: [],
    replyToMode: 'first',
    chunkMode: 'newline',
    textChunkLimit: 2000,
    modeAdmins: [],
    ...overrides,
  }
}

function makeFacts(overrides: Partial<InboundFacts> = {}): InboundFacts {
  return {
    authorId: 'author-1',
    authorIsBot: false,
    isSelf: false,
    isDM: false,
    channelId: 'ch-1',
    parentChannelId: null,
    mentioned: true,
    ...overrides,
  }
}

describe('decide', () => {
  test('手順1: isSelf が true なら他の条件を満たしていても drop', () => {
    const cfg = makeConfig({
      allowBots: ['self-id'],
      dmAllowFrom: ['self-id'],
      channels: { 'ch-1': { requireMention: false, allowFrom: ['self-id'] } },
    })
    expect(decide(cfg, makeFacts({ authorId: 'self-id', isSelf: true, isDM: true }))).toBe('drop')
    expect(decide(cfg, makeFacts({ authorId: 'self-id', isSelf: true, authorIsBot: true }))).toBe(
      'drop',
    )
  })

  test('手順2: authorIsBot で allowBots に含まれなければ drop', () => {
    const cfg = makeConfig({
      dmAllowFrom: ['bot-1'],
      channels: { 'ch-1': { requireMention: false, allowFrom: ['bot-1'] } },
      allowBots: ['other-bot'],
    })
    expect(decide(cfg, makeFacts({ authorId: 'bot-1', authorIsBot: true, isDM: true }))).toBe(
      'drop',
    )
    expect(decide(cfg, makeFacts({ authorId: 'bot-1', authorIsBot: true, isDM: false }))).toBe(
      'drop',
    )
  })

  test('手順2: authorIsBot でも allowBots に含まれれば以降の判定へ進む', () => {
    const cfg = makeConfig({
      allowBots: ['bot-1'],
      dmAllowFrom: ['bot-1'],
      channels: { 'ch-1': { requireMention: false, allowFrom: [] } },
    })
    expect(
      decide(cfg, makeFacts({ authorId: 'bot-1', authorIsBot: true, isDM: true, mentioned: false })),
    ).toBe('deliver')
    expect(
      decide(
        cfg,
        makeFacts({ authorId: 'bot-1', authorIsBot: true, isDM: false, mentioned: false }),
      ),
    ).toBe('deliver')
    // allowBots にいても未許可チャンネルでは drop
    expect(
      decide(
        cfg,
        makeFacts({
          authorId: 'bot-1',
          authorIsBot: true,
          isDM: false,
          channelId: 'ch-unknown',
        }),
      ),
    ).toBe('drop')
  })

  test('手順3: DM は dmAllowFrom に含まれれば deliver（メンション不要）、含まれなければ drop', () => {
    const cfg = makeConfig({
      dmAllowFrom: ['dm-ok'],
      channels: { 'dm-ch': { requireMention: false } },
    })
    expect(
      decide(
        cfg,
        makeFacts({ authorId: 'dm-ok', isDM: true, channelId: 'any-dm', mentioned: false }),
      ),
    ).toBe('deliver')
    expect(
      decide(
        cfg,
        makeFacts({ authorId: 'dm-ng', isDM: true, channelId: 'dm-ch', mentioned: true }),
      ),
    ).toBe('drop')
  })

  test('手順4: サーバーの未許可チャンネルは drop', () => {
    const cfg = makeConfig({
      channels: { 'ch-allowed': { requireMention: false } },
    })
    expect(decide(cfg, makeFacts({ channelId: 'ch-other', mentioned: true }))).toBe('drop')
  })

  test('手順4: スレッドは parentChannelId で channels を引く', () => {
    const cfg = makeConfig({
      channels: {
        'parent-1': { requireMention: false },
        'thread-only': { requireMention: false },
      },
    })
    // 親チャンネルが許可リストにあるスレッドは deliver
    expect(
      decide(cfg, makeFacts({ channelId: 'thread-99', parentChannelId: 'parent-1' })),
    ).toBe('deliver')
    // 親チャンネルが許可リストにないスレッドは drop（thread ID があっても親を優先）
    expect(
      decide(cfg, makeFacts({ channelId: 'thread-only', parentChannelId: 'parent-unknown' })),
    ).toBe('drop')
    // parentChannelId が null / undefined なら channelId を使う
    expect(decide(cfg, makeFacts({ channelId: 'parent-1', parentChannelId: null }))).toBe('deliver')
    expect(decide(cfg, makeFacts({ channelId: 'parent-1', parentChannelId: undefined }))).toBe(
      'deliver',
    )
  })

  test('手順5: チャンネルの allowFrom が空でなく authorId を含まない場合は drop', () => {
    const cfg = makeConfig({
      channels: {
        'ch-restricted': { requireMention: false, allowFrom: ['allowed-1', 'allowed-2'] },
        'ch-open-empty': { requireMention: false, allowFrom: [] },
        'ch-open-omitted': { requireMention: false },
      },
    })
    expect(decide(cfg, makeFacts({ channelId: 'ch-restricted', authorId: 'outsider' }))).toBe(
      'drop',
    )
    expect(decide(cfg, makeFacts({ channelId: 'ch-restricted', authorId: 'allowed-2' }))).toBe(
      'deliver',
    )
    expect(decide(cfg, makeFacts({ channelId: 'ch-open-empty', authorId: 'anyone' }))).toBe(
      'deliver',
    )
    expect(decide(cfg, makeFacts({ channelId: 'ch-open-omitted', authorId: 'anyone' }))).toBe(
      'deliver',
    )
  })

  test('手順6: requireMention は省略時 true、true かつ !mentioned なら drop、false なら !mentioned でも deliver', () => {
    const cfg = makeConfig({
      channels: {
        'ch-default': {},
        'ch-req': { requireMention: true },
        'ch-noreq': { requireMention: false },
      },
    })
    expect(decide(cfg, makeFacts({ channelId: 'ch-default', mentioned: false }))).toBe('drop')
    expect(decide(cfg, makeFacts({ channelId: 'ch-default', mentioned: true }))).toBe('deliver')

    expect(decide(cfg, makeFacts({ channelId: 'ch-req', mentioned: false }))).toBe('drop')
    expect(decide(cfg, makeFacts({ channelId: 'ch-req', mentioned: true }))).toBe('deliver')

    expect(decide(cfg, makeFacts({ channelId: 'ch-noreq', mentioned: false }))).toBe('deliver')
    expect(decide(cfg, makeFacts({ channelId: 'ch-noreq', mentioned: true }))).toBe('deliver')
  })
})

describe('canSendTo', () => {
  const cfg = makeConfig({
    dmAllowFrom: ['recipient-1'],
    channels: {
      'ch-1': { requireMention: true },
      'parent-1': { requireMention: false },
    },
  })

  test('DM は dmRecipientId が dmAllowFrom に含まれるときだけ true', () => {
    const ok: OutboundTarget = { isDM: true, channelId: 'dm-ch', dmRecipientId: 'recipient-1' }
    const ng: OutboundTarget = { isDM: true, channelId: 'dm-ch', dmRecipientId: 'stranger' }
    const missing: OutboundTarget = { isDM: true, channelId: 'dm-ch', dmRecipientId: null }
    const undef: OutboundTarget = { isDM: true, channelId: 'dm-ch' }

    expect(canSendTo(cfg, ok)).toBe(true)
    expect(canSendTo(cfg, ng)).toBe(false)
    expect(canSendTo(cfg, missing)).toBe(false)
    expect(canSendTo(cfg, undef)).toBe(false)
  })

  test('サーバーは parentChannelId ?? channelId が channels にあれば true', () => {
    expect(canSendTo(cfg, { isDM: false, channelId: 'ch-1' })).toBe(true)
    expect(canSendTo(cfg, { isDM: false, channelId: 'ch-1', parentChannelId: null })).toBe(true)
    expect(canSendTo(cfg, { isDM: false, channelId: 'ch-unknown' })).toBe(false)
    expect(canSendTo(cfg, { isDM: false, channelId: 'thread-1', parentChannelId: 'parent-1' })).toBe(
      true,
    )
    expect(canSendTo(cfg, { isDM: false, channelId: 'ch-1', parentChannelId: 'parent-ng' })).toBe(
      false,
    )
  })
})

describe('matchesMentionPattern', () => {
  test('空のパターン配列は false', () => {
    expect(matchesMentionPattern('hello bot', [])).toBe(false)
  })

  test('大文字・小文字を無視して正規表現マッチする', () => {
    expect(matchesMentionPattern('Hey CLAUDE, help me', ['claude'])).toBe(true)
    expect(matchesMentionPattern('BOT: ping', ['^bot:'])).toBe(true)
    expect(matchesMentionPattern('nothing here', ['claude', '^bot:'])).toBe(false)
  })

  test('複数パターンのいずれかが合えば true', () => {
    expect(matchesMentionPattern('呼び出しテスト', ['alice', '呼び出し'])).toBe(true)
  })

  test('不正な正規表現は無視して例外を出さず、後続の有効パターンを評価する', () => {
    expect(() => matchesMentionPattern('hello', ['[unclosed', '(bad'])).not.toThrow()
    expect(matchesMentionPattern('hello', ['[unclosed', '(bad'])).toBe(false)
    expect(matchesMentionPattern('Hello World', ['[unclosed', 'world'])).toBe(true)
  })
})
