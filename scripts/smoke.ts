import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/** スモークテスト用のワークスペース検証（DISCORD_BOT_TOKEN は使わない） */
function readWorkspaceFromEnv(): string {
  const rawWorkspace = process.env.BOT_WORKSPACE?.trim();
  if (!rawWorkspace) {
    throw new Error('BOT_WORKSPACE を指定してください');
  }
  const workspace = resolve(rawWorkspace);
  let isDir = false;
  try {
    isDir = statSync(workspace).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(`BOT_WORKSPACE が存在するディレクトリではありません: ${workspace}`);
  }
  return workspace;
}

async function main(): Promise<void> {
  const workspace = readWorkspaceFromEnv();
  const model = process.env.BOT_MODEL?.trim() || undefined;

  // Discord に接続せずツール定義のみ認識させるダミー MCP サーバー
  const dummyMcpServer = createSdkMcpServer({
    name: 'plugin_discord_discord',
    version: '1.0.0',
    tools: [
      tool(
        'reply',
        'Dummy reply tool for smoke test.',
        {
          chat_id: z.string(),
          text: z.string(),
        },
        async () => ({
          content: [{ type: 'text', text: 'dummy reply ok' }],
        }),
      ),
    ],
  });

  const options: Options = {
    cwd: workspace,
    settingSources: ['project', 'local'],
    mcpServers: {
      plugin_discord_discord: dummyMcpServer,
    },
    permissionMode: 'dontAsk',
    skills: 'all',
    maxTurns: 3,
    allowedTools: ['Read'],
    ...(model !== undefined ? { model } : {}),
    stderr: (d) => process.stderr.write(d),
  };

  const promptText =
    'ツールは呼ばずに、ワークスペースの CLAUDE.md に書かれたルールを 3 つ短く挙げてください';

  const assistantTexts: string[] = [];
  let resultText = '';
  let isError = false;

  for await (const msg of query({ prompt: promptText, options })) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      const discordTools = msg.tools.filter((name) => name.toLowerCase().includes('discord'));
      const topSkills = msg.skills.slice(0, 20);
      console.log(`モデル: ${msg.model}`);
      console.log(`discord を含むツール (${discordTools.length}): ${discordTools.join(', ') || '(なし)'}`);
      console.log(`スキル一覧 (先頭 ${topSkills.length} / 全 ${msg.skills.length}):`);
      for (const skill of topSkills) {
        console.log(`  - ${skill}`);
      }
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          assistantTexts.push(block.text);
        }
      }
    } else if (msg.type === 'result') {
      isError = msg.is_error;
      if (msg.subtype === 'success' && msg.result) {
        resultText = msg.result;
      } else if ('errors' in msg && msg.errors && msg.errors.length > 0) {
        resultText = msg.errors.join('\n');
      }
      const output = resultText || assistantTexts.join('\n');
      console.log('\n--- 応答テキスト ---');
      console.log(output || '(空)');
      console.log('--------------------');
      console.log(`コスト: $${msg.total_cost_usd.toFixed(6)} (subtype=${msg.subtype}, turns=${msg.num_turns})`);
    }
  }

  if (isError) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error('スモークテスト失敗:', err);
  process.exit(1);
});
