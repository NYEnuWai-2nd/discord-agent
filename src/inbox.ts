import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Claude Agent SDK へのストリーミング入力用 FIFO キュー。
 */
export class Inbox {
  private readonly queue: string[] = [];
  private waiters: Array<() => void> = [];
  private generation = 0;

  /** 未消費のメッセージ件数 */
  get size(): number {
    return this.queue.length;
  }

  /** メッセージを末尾に追加し、待機中のストリームをすべて起こす */
  push(text: string): void {
    this.queue.push(text);
    this.wakeAll();
  }

  private wakeAll(): void {
    const pending = this.waiters.splice(0);
    for (const wake of pending) {
      wake();
    }
  }

  /**
   * SDK へ渡す入力ストリームを生成する。
   * 新しく呼ばれた場合、古いジェネレーターは待機から抜けて新しい方へ処理を譲る。
   */
  async *stream(): AsyncGenerator<SDKUserMessage> {
    const myGen = ++this.generation;
    // 古い世代のジェネレーターが待機中なら起こして終了させる
    this.wakeAll();

    while (myGen === this.generation) {
      if (this.queue.length === 0) {
        let resolver: (() => void) | undefined;
        await new Promise<void>((resolve) => {
          resolver = resolve;
          this.waiters.push(resolve);
        });
        if (resolver) {
          const idx = this.waiters.indexOf(resolver);
          if (idx !== -1) this.waiters.splice(idx, 1);
        }
        continue;
      }

      const text = this.queue.shift()!;
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: text,
        },
        parent_tool_use_id: null,
      };
    }
  }
}
