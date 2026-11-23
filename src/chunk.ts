/**
 * メッセージを指定文字数以下で分割する。
 */
export function splitMessage(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  if (text.length <= safeLimit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > safeLimit) {
    let cut = safeLimit;
    let skipSpace = false;

    if (mode === 'newline') {
      const window = remaining.slice(0, safeLimit);
      const half = safeLimit / 2;
      const doubleNl = window.lastIndexOf('\n\n');
      if (doubleNl > half) {
        cut = doubleNl;
      } else {
        const singleNl = window.lastIndexOf('\n');
        if (singleNl > half) {
          cut = singleNl;
        } else {
          const space = window.lastIndexOf(' ');
          if (space > 0) {
            cut = space;
            skipSpace = true;
          }
        }
      }
    }

    const chunk = remaining.slice(0, cut);
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(skipSpace ? cut + 1 : cut).replace(/^\n+/, '');
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
