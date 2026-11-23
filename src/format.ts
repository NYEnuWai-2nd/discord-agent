/** 添付ファイルのメタ情報 */
export type AttachmentInfo = {
  name: string;
  contentType: string | null;
  sizeBytes: number;
};

/** 受信メッセージのメタ情報 */
export type InboundMeta = {
  chatId: string;
  messageId: string;
  authorName: string;
  displayName: string;
  authorId: string;
  ts: string;
  replyToMessageId?: string | null;
  attachments: AttachmentInfo[];
  content: string;
};

/** 履歴行のメタ情報 */
export type HistoryLine = {
  iso: string;
  who: string;
  content: string;
  id: string;
  attachmentCount: number;
  replyTo?: string | null;
};

/**
 * 添付ファイル名に含まれる区切り文字・制御文字を `_` に置き換える。
 */
export function sanitizeAttachmentName(name: string): string {
  return name.replace(/[\[\]\r\n;"<>]/g, '_');
}

/**
 * XML/チャンネルタグ属性値を安全化する。
 * 連続する改行を半角スペース 1 つに、`"` を `'` に置き換える。
 */
export function escapeAttr(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/"/g, "'");
}

/**
 * Discord 受信メッセージを `<channel source="plugin:discord:discord" ...>` 形式に整形する。
 */
export function formatInbound(m: InboundMeta): string {
  const attrs: string[] = [
    `source="plugin:discord:discord"`,
    `chat_id="${escapeAttr(m.chatId)}"`,
    `message_id="${escapeAttr(m.messageId)}"`,
    `user="${escapeAttr(m.authorName)}"`,
    `display_name="${escapeAttr(m.displayName)}"`,
    `user_id="${escapeAttr(m.authorId)}"`,
    `ts="${escapeAttr(m.ts)}"`,
  ];

  if (m.replyToMessageId) {
    attrs.push(`reply_to_message_id="${escapeAttr(m.replyToMessageId)}"`);
  }

  if (m.attachments.length > 0) {
    const list = m.attachments
      .map((att) => {
        const kb = (att.sizeBytes / 1024).toFixed(0);
        const type = att.contentType ?? 'unknown';
        return `${sanitizeAttachmentName(att.name)} (${type}, ${kb}KB)`;
      })
      .join('; ');
    attrs.push(`attachment_count="${escapeAttr(String(m.attachments.length))}"`);
    attrs.push(`attachments="${escapeAttr(list)}"`);
  }

  const rawBody = m.content !== '' ? m.content : m.attachments.length > 0 ? '(attachment)' : '';
  // 本文内の <channel / </channel によるタグ偽造を防止する
  const body = rawBody.replace(/<(\/?channel)/gi, '\u2039$1');

  return `<channel ${attrs.join(' ')}>\n${body}\n</channel>`;
}

/**
 * fetch_messages 用の 1 行履歴文字列を整形する。
 */
export function formatHistoryLine(h: HistoryLine): string {
  const text = h.content.replace(/[\r\n]+/g, ' ⏎ ');
  const att = h.attachmentCount >= 1 ? ` +${h.attachmentCount}att` : '';
  const re = h.replyTo ? ` re:${h.replyTo}` : '';
  return `[${h.iso}] ${h.who}: ${text}  (id: ${h.id}${att}${re})`;
}
