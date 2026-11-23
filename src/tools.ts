import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { DiscordTools } from './discord.ts';
import { toolShapes } from './tool-schemas.ts';

type TextToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** ツール実行時の例外を捕捉して MCP の isError レスポンスに変換する */
async function wrapTool(name: string, fn: () => Promise<string>): Promise<TextToolResult> {
  try {
    const text = await fn();
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `${name} failed: ${msg}` }], isError: true };
  }
}

/**
 * Discord 操作用ツール群を提供するインプロセス MCP サーバーを作成する。
 * サーバー名は Claude Code 側のプラグイン許可設定と一致させるため plugin_discord_discord 固定。
 */
export function createDiscordMcpServer(tools: DiscordTools): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'plugin_discord_discord',
    version: '1.0.0',
    tools: [
      tool(
        'reply',
        'Send a message to an allowlisted Discord channel or DM. Long text is automatically split at 2000 characters. Up to 10 local file paths can be attached on the first chunk (max 25MB per file).',
        toolShapes.reply,
        (args) => wrapTool('reply', () => tools.reply(args)),
      ),

      tool(
        'react',
        'Add an emoji reaction to a message in an allowlisted Discord channel.',
        toolShapes.react,
        (args) => wrapTool('react', () => tools.react(args)),
      ),

      tool(
        'edit_message',
        'Edit a message previously sent by this bot in an allowlisted Discord channel.',
        toolShapes.edit_message,
        (args) => wrapTool('edit_message', () => tools.editMessage(args)),
      ),

      tool(
        'download_attachment',
        'Download all attachments from a Discord message into the local inbox directory (max 25MB per attachment).',
        toolShapes.download_attachment,
        (args) => wrapTool('download_attachment', () => tools.downloadAttachment(args)),
      ),

      tool(
        'fetch_messages',
        'Fetch recent message history from an allowlisted Discord channel (default 20, max 100 messages). Discord does not provide a bot message search API.',
        toolShapes.fetch_messages,
        (args) => wrapTool('fetch_messages', () => tools.fetchMessages(args)),
      ),

      tool(
        'list_members',
        'List members of a Discord server channel or look up a single member by user_id (default 100, max 1000). Listing all members requires Server Members Intent.',
        toolShapes.list_members,
        (args) =>
          wrapTool('list_members', () =>
            tools.listMembers({
              channel: args.channel,
              memberId: args.user_id,
              limit: args.limit,
            }),
          ),
      ),
    ],
  });
}
