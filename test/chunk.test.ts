import { describe, expect, test } from 'bun:test'
import { splitMessage } from '../src/chunk.ts'

describe('splitMessage', () => {
  describe('基本動作（空文字・短い文字列・境界ちょうど）', () => {
    test('空文字は length / newline どちらでも [""] を返す', () => {
      expect(splitMessage('', 2000, 'length')).toEqual([''])
      expect(splitMessage('', 2000, 'newline')).toEqual([''])
      expect(splitMessage('', 1, 'newline')).toEqual([''])
    })

    test('limit 未満の文字列はそのまま 1 要素で返す', () => {
      expect(splitMessage('hello', 10, 'length')).toEqual(['hello'])
      expect(splitMessage('hello\n\nworld', 20, 'newline')).toEqual(['hello\n\nworld'])
    })

    test('ちょうど limit 文字の文字列は分割しない', () => {
      const exact = 'a'.repeat(10)
      expect(splitMessage(exact, 10, 'length')).toEqual([exact])
      expect(splitMessage(exact, 10, 'newline')).toEqual([exact])
    })
  })

  describe('length モード', () => {
    test('ちょうど limit 文字ごとに分割する', () => {
      expect(splitMessage('abcdefghij', 4, 'length')).toEqual(['abcd', 'efgh', 'ij'])
    })

    test('改行や空白があってもちょうど limit 文字で切る', () => {
      expect(splitMessage('ab cdef ghij', 4, 'length')).toEqual(['ab c', 'def ', 'ghij'])
      expect(splitMessage('a\nb cd\nef', 4, 'length')).toEqual(['a\nb ', 'cd\ne', 'f'])
    })

    test('limit = 1 でも各要素が 1 文字で分割される', () => {
      expect(splitMessage('abc', 1, 'length')).toEqual(['a', 'b', 'c'])
    })
  })

  describe('newline モードの優先順位としきい値', () => {
    test('\\n\\n が limit/2 より後ろにあれば、それより後ろの \\n より \\n\\n を優先する', () => {
      // limit=12, limit/2=6: '\n\n' は index 7 (> 6)、'\n' は index 11 (> 6)
      const text = '1234567\n\n89\nabcdef'
      expect(splitMessage(text, 12, 'newline')).toEqual(['1234567', '89\nabcdef'])
    })

    test('\\n\\n が limit/2 より前の場合は無視し、limit/2 より後ろの \\n で切る', () => {
      // limit=10, limit/2=5: '\n\n' は index 3 (<= 5)、'\n' は index 8 (> 5)
      const text = 'abc\n\ndef\nghijk'
      expect(splitMessage(text, 10, 'newline')).toEqual(['abc\n\ndef', 'ghijk'])
    })

    test('\\n\\n がちょうど limit/2 にある場合は使わない（より後ろの条件）', () => {
      // limit=10, limit/2=5: '\n\n' は index 5 (=== 5, not > 5)、'\n' は index 8 (> 5)
      const text = '12345\n\n8\n9abcd'
      expect(splitMessage(text, 10, 'newline')).toEqual(['12345\n\n8', '9abcd'])
    })

    test('\\n が limit/2 より後ろにあれば、それより後ろの空白より \\n を優先する', () => {
      // limit=12, limit/2=6: '\n' は index 7 (> 6)、' ' は index 10
      const text = '1234567\n89 abcd'
      expect(splitMessage(text, 12, 'newline')).toEqual(['1234567', '89 abcd'])
    })

    test('\\n が limit/2 より前の場合は無視し、0 より後ろの最後の空白で切る', () => {
      // limit=10, limit/2=5: '\n' は index 3 (<= 5)、' ' は index 7 (> 0)
      const text = 'abc\ndef ghijkl'
      const parts = splitMessage(text, 10, 'newline')
      expect(parts.length).toBe(2)
      expect(parts[0]!.trimEnd()).toBe('abc\ndef')
      expect(parts[1]!.trimStart()).toBe('ghijkl')
      for (const p of parts) {
        expect(p.length).toBeGreaterThan(0)
        expect(p.length).toBeLessThanOrEqual(10)
      }
    })

    test('\\n がちょうど limit/2 にある場合は使わず空白にフォールバックする', () => {
      // limit=10, limit/2=5: '\n' は index 5 (=== 5, not > 5)、' ' は index 8 (> 0)
      const text = '12345\n78 abcde'
      const parts = splitMessage(text, 10, 'newline')
      expect(parts.length).toBe(2)
      expect(parts[0]!.trimEnd()).toBe('12345\n78')
      expect(parts[1]!.trimStart()).toBe('abcde')
    })

    test('空白が index 0 にしかない場合はハードカットにフォールバックする', () => {
      // limit=10: 先頭のみ空白、以降区切りなし
      expect(splitMessage(' abcdefghijk', 10, 'newline')).toEqual([' abcdefghi', 'jk'])
    })

    test('区切り文字が一切なければ limit でハードカットする', () => {
      expect(splitMessage('abcdefghijklmno', 10, 'newline')).toEqual(['abcdefghij', 'klmno'])
    })
  })

  describe('残りの先頭改行の除去と不変条件', () => {
    test('切った後の残りの先頭にある連続改行を捨てる', () => {
      // limit=8, limit/2=4: '\n\n' は index 6 (> 4)、残りは '\n\n\n\nghijkl'
      expect(splitMessage('abcdef\n\n\n\nghijkl', 8, 'newline')).toEqual(['abcdef', 'ghijkl'])
    })

    test('残りが改行だけになっても空要素を返さない', () => {
      expect(splitMessage('abcdef\n\n\n\n', 8, 'newline')).toEqual(['abcdef'])
      expect(splitMessage('abcdefgh\n\n', 8, 'newline')).toEqual(['abcdefgh'])
    })

    test('長文の分割結果はいずれも limit 以下かつ空文字を含まない', () => {
      const limit = 25
      const text = [
        'paragraph one line one\nparagraph one line two',
        'paragraph two with a verylongwordwithoutanyspacesatall1234567890',
        'short\n\n\n\ntrailing words here and there',
      ].join('\n\n')

      for (const mode of ['newline', 'length'] as const) {
        const parts = splitMessage(text, limit, mode)
        expect(parts.length).toBeGreaterThan(1)
        for (const part of parts) {
          expect(part.length).toBeGreaterThan(0)
          expect(part.length).toBeLessThanOrEqual(limit)
        }
      }
    })
  })
})
