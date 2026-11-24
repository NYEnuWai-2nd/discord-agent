import { z } from 'zod';

/**
 * Discord 操作ツールの引数スキーマ定義。
 * MCP サーバー（tools.ts）と HTTP ツールサーバー（tool-server.ts）で共有し、仕様のズレを防ぐ。
 */
export const toolShapes = {
  reply: {
    chat_id: z.string().describe('Target Discord channel ID'),
    text: z.string().describe('Message text to send'),
    reply_to: z.string().optional().describe('Optional message ID to reply to'),
    files: z
      .array(z.string())
      .optional()
      .describe('Optional list of local file paths to attach (max 10 files, 25MB each)'),
  },
  react: {
    chat_id: z.string().describe('Discord channel ID'),
    message_id: z.string().describe('Target message ID'),
    emoji: z.string().describe('Unicode emoji or custom emoji string'),
  },
  edit_message: {
    chat_id: z.string().describe('Discord channel ID'),
    message_id: z.string().describe('Bot message ID to edit'),
    text: z.string().describe('Replacement message text'),
  },
  download_attachment: {
    chat_id: z.string().describe('Discord channel ID'),
    message_id: z.string().describe('Message ID with attachments'),
  },
  fetch_messages: {
    channel: z.string().describe('Discord channel ID'),
    limit: z
      .number()
      .optional()
      .describe('Number of recent messages to fetch (default 20, max 100)'),
  },
  list_members: {
    channel: z.string().describe('Server Discord channel ID'),
    user_id: z.string().optional().describe('Optional Discord user ID to look up directly'),
    limit: z
      .number()
      .optional()
      .describe('Maximum number of members to list (default 100, max 1000)'),
  },
  set_state: {
    chat_id: z.string().describe('Discord channel ID where the instruction message was sent'),
    message_id: z.string().describe('Discord message ID instructing the state change'),
    key: z.string().describe('Top-level key name in 現在の状態.md'),
    value: z.string().describe('New state value (single line, max 200 chars)'),
  },
  add_person: {
    name: z.string().describe('Person name (max 50 chars)'),
    user_id: z.string().describe('Numeric Discord account ID or "不明"'),
    description: z.string().describe('Person description (max 400 chars)'),
  },
  note_person: {
    user_id: z.string().describe('Numeric Discord account ID'),
    note: z.string().describe('Note to append to description (single line, max 150 chars)'),
  },
  list_models: {},
  set_model: {
    chat_id: z.string().describe('Discord channel ID where the instruction message was sent'),
    message_id: z.string().describe('Discord message ID instructing the model change'),
    model: z.string().describe('Target model ID to switch to'),
  },
  write_journal: {
    text: z.string().describe('Journal entry body (1 to 6000 chars)'),
    date: z.string().optional().describe('Optional date in YYYY-MM-DD (JST, default: today)'),
  },
};
