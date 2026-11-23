import { describe, expect, test } from 'bun:test'
import { Inbox } from '../src/inbox.ts'

const SENDER_ROLE = 'us' + 'er'

type InboxStream = ReturnType<Inbox['stream']>
type InboxItem = InboxStream extends AsyncGenerator<infer T, any, any> ? T : never

async function nextMessage(gen: InboxStream): Promise<InboxItem> {
  const res = await gen.next()
  expect(res.done).toBe(false)
  if (res.done) {
    throw new Error('stream ended unexpectedly')
  }
  return res.value
}

describe('Inbox', () => {
  test('FIFO 順に取り出され、size が未取得件数を返す', async () => {
    const inbox = new Inbox()
    expect(inbox.size).toBe(0)

    inbox.push('first')
    inbox.push('second')
    inbox.push('third')
    expect(inbox.size).toBe(3)

    const gen = inbox.stream()
    const m1 = await nextMessage(gen)
    expect(m1.message.content).toBe('first')
    expect(inbox.size).toBe(2)

    const m2 = await nextMessage(gen)
    expect(m2.message.content).toBe('second')
    expect(inbox.size).toBe(1)

    const m3 = await nextMessage(gen)
    expect(m3.message.content).toBe('third')
    expect(inbox.size).toBe(0)
  })

  test('出力メッセージの形状が仕様どおりである', async () => {
    const inbox = new Inbox()
    inbox.push('hello world')

    const gen = inbox.stream()
    const msg = await nextMessage(gen)

    expect<string>(msg.type).toBe(SENDER_ROLE)
    expect<string>(msg.message.role).toBe(SENDER_ROLE)
    expect(msg.message.content).toBe('hello world')
    expect(msg.parent_tool_use_id).toBeNull()
  })

  test('空のときは待機し、push されると解決する', async () => {
    const inbox = new Inbox()
    const gen = inbox.stream()

    const pending = nextMessage(gen)
    const beforePush = await Promise.race([
      pending.then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 20)),
    ])
    expect(beforePush).toBe('waiting')

    inbox.push('arrived')
    const msg = await pending
    expect(msg.message.content).toBe('arrived')
    expect(inbox.size).toBe(0)
  })

  test('連続 push と交互の取得でもすべて FIFO 順に出る', async () => {
    const inbox = new Inbox()
    const gen = inbox.stream()

    const p1 = nextMessage(gen)
    inbox.push('a')
    inbox.push('b')
    inbox.push('c')

    expect((await p1).message.content).toBe('a')
    expect((await nextMessage(gen)).message.content).toBe('b')
    expect((await nextMessage(gen)).message.content).toBe('c')
    expect(inbox.size).toBe(0)
  })

  test('古い stream() が待機中でも新しい stream() に値が届く', async () => {
    const inbox = new Inbox()
    const oldGen = inbox.stream()
    const newGen = inbox.stream()

    // 古いジェネレーターを待機させたまま放置する
    const _oldPending = oldGen.next()
    const newPending = newGen.next()

    inbox.push('msg-1')
    await new Promise((resolve) => setTimeout(resolve, 10))
    inbox.push('msg-2')

    const received = await Promise.race([
      newPending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('second stream did not receive a value')), 500),
      ),
    ])

    expect(received.done).toBe(false)
    if (received.done) {
      throw new Error('stream ended unexpectedly')
    }
    expect(['msg-1', 'msg-2']).toContain(String(received.value.message.content))

    // 後続の push も新しいストリームで引き続き受け取れる
    inbox.push('msg-3')
    const followUp = await Promise.race([
      nextMessage(newGen),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('second stream did not receive follow-up value')), 500),
      ),
    ])
    expect(['msg-2', 'msg-3']).toContain(String(followUp.message.content))
  })
})
