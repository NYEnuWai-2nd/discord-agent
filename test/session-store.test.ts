import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSessionId, saveSessionId } from '../src/session-store.ts'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-agent-session-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('session-store', () => {
  test('保存して読み戻せる（session.json に sessionId と savedAt の ISO 文字列が入る）', () => {
    const dir = makeTempDir()
    saveSessionId(dir, 'session-abc-123')

    expect(loadSessionId(dir)).toBe('session-abc-123')

    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as {
      sessionId: unknown
      savedAt: unknown
    }
    expect(raw.sessionId).toBe('session-abc-123')
    expect(typeof raw.savedAt).toBe('string')
    expect(Number.isNaN(Date.parse(raw.savedAt as string))).toBe(false)
  })

  test('ディレクトリが存在しなくても作成して保存できる', () => {
    const base = makeTempDir()
    const nested = path.join(base, 'a', 'b', 'state')

    saveSessionId(nested, 'session-nested')
    expect(loadSessionId(nested)).toBe('session-nested')
  })

  test('再保存すると最新の sessionId で上書きされる', () => {
    const dir = makeTempDir()
    saveSessionId(dir, 'first-id')
    saveSessionId(dir, 'second-id')
    expect(loadSessionId(dir)).toBe('second-id')
  })

  test('ファイルやディレクトリが存在しないときは undefined を返す', () => {
    const dir = makeTempDir()
    expect(loadSessionId(dir)).toBeUndefined()
    expect(loadSessionId(path.join(dir, 'missing-dir'))).toBeUndefined()
  })

  test('JSON が壊れているときは undefined を返す', () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'session.json')

    fs.writeFileSync(file, '{ broken json', 'utf8')
    expect(loadSessionId(dir)).toBeUndefined()

    fs.writeFileSync(file, '', 'utf8')
    expect(loadSessionId(dir)).toBeUndefined()
  })

  test('sessionId が文字列でない・欠けている・JSON がオブジェクトでないときは undefined を返す', () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'session.json')

    const invalidPayloads: unknown[] = [
      { sessionId: 12345, savedAt: '2026-01-01T00:00:00.000Z' },
      { sessionId: null, savedAt: '2026-01-01T00:00:00.000Z' },
      { sessionId: true, savedAt: '2026-01-01T00:00:00.000Z' },
      { sessionId: ['id'], savedAt: '2026-01-01T00:00:00.000Z' },
      { sessionId: { id: 'x' }, savedAt: '2026-01-01T00:00:00.000Z' },
      { savedAt: '2026-01-01T00:00:00.000Z' },
      null,
      'plain-string',
      42,
    ]

    for (const payload of invalidPayloads) {
      fs.writeFileSync(file, JSON.stringify(payload), 'utf8')
      expect(loadSessionId(dir)).toBeUndefined()
    }
  })
})
