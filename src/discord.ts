import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Partials,
  Routes,
  type APIGuildMember,
  type APIMessage,
  type MessageCreateOptions,
} from 'discord.js';
import { splitMessage } from './chunk.ts';
import type { BotConfig, Env } from './config.ts';
import { formatHistoryLine, formatInbound, sanitizeAttachmentName, type AttachmentInfo } from './format.ts';
import { canSendTo, decide, matchesMentionPattern, type InboundFacts } from './gate.ts';
import type { MsgLite } from './patrol.ts';

/** このリポジトリのルートディレクトリ（import.meta.url 基準） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Discord 添付ファイルの最大サイズ (25 MB) */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** reply で添付可能な最大ファイル数 */
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** 入力中表示の再送間隔 (8 秒) */
const TYPING_INTERVAL_MS = 8_000;
/** 入力中表示のタイムアウト (2 分) */
const TYPING_TIMEOUT_MS = 120_000;
/** 返信先判定用に保持する最近の送信メッセージ ID 上限 */
const MAX_RECENT_BOT_IDS = 200;

/** JST (Asia/Tokyo) の [HH:MM:SS] タイムスタンプを返す */
function jstPrefix(): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
  return `[${time}]`;
}

/** Windows では大文字小文字を区別せず比較できるよう正規化する */
function normPathForCompare(p: string): string {
  const resolved = resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 存在すれば realpath、存在しなければ resolve したパスを返す */
function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** targetReal が dirReal 自身またはその配下にあるか判定する */
function isSameOrInsideDir(targetReal: string, dirReal: string): boolean {
  const t = normPathForCompare(targetReal);
  const d = normPathForCompare(dirReal);
  if (t === d) return true;
  const prefix = d.endsWith(sep) ? d : d + sep;
  return t.startsWith(prefix);
}

export type DiscordTools = {
  reply(a: { chat_id: string; text: string; reply_to?: string; files?: string[] }): Promise<string>;
  react(a: { chat_id: string; message_id: string; emoji: string }): Promise<string>;
  editMessage(a: { chat_id: string; message_id: string; text: string }): Promise<string>;
  downloadAttachment(a: { chat_id: string; message_id: string }): Promise<string>;
  fetchMessages(a: { channel: string; limit?: number }): Promise<string>;
  listMembers(a: { channel: string; memberId?: string; limit?: number }): Promise<string>;
  getMessageAuthor(chatId: string, messageId: string): Promise<{ authorId: string; content: string }>;
};

/**
 * Discord クライアントと各種操作ツールを生成する。
 */
export function createDiscord(opts: { env: Env; getConfig: () => BotConfig }): {
  client: Client;
  tools: DiscordTools;
  login(): Promise<void>;
  onInbound(handler: (text: string, chatId: string) => void): void;
  fetchSnapshot(channelId: string, limit?: number): Promise<{ lite: MsgLite[]; history: string }>;
  stopTyping(): void;
  destroy(): Promise<void>;
} {
  const { env, getConfig } = opts;

  // Server Members Intent (GuildMembers) は未許可時に接続エラーとなるため使わない
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  let inboundHandler: ((text: string, chatId: string) => void) | undefined;

  // bot 自身が最近送ったメッセージ ID（返信による暗黙メンション判定用）
  const recentBotIdsQueue: string[] = [];
  const recentBotIdSet = new Set<string>();

  // DM チャンネル ID → 相手のユーザー ID のキャッシュ
  const dmRecipients = new Map<string, string>();

  let typingTimer: ReturnType<typeof setInterval> | null = null;
  let typingTimeout: ReturnType<typeof setTimeout> | null = null;

  function rememberBotMessage(id: string): void {
    if (recentBotIdSet.has(id)) return;
    recentBotIdsQueue.push(id);
    recentBotIdSet.add(id);
    if (recentBotIdsQueue.length > MAX_RECENT_BOT_IDS) {
      const oldest = recentBotIdsQueue.shift();
      if (oldest !== undefined) {
        recentBotIdSet.delete(oldest);
      }
    }
  }

  function stopTyping(): void {
    if (typingTimer !== null) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
    if (typingTimeout !== null) {
      clearTimeout(typingTimeout);
      typingTimeout = null;
    }
  }

  function startTyping(channel: { sendTyping: () => Promise<void> }): void {
    stopTyping();
    void channel.sendTyping().catch(() => {});
    typingTimer = setInterval(() => {
      void channel.sendTyping().catch(() => {});
    }, TYPING_INTERVAL_MS);
    typingTimeout = setTimeout(() => {
      stopTyping();
    }, TYPING_TIMEOUT_MS);
  }

  /** 送信・操作対象チャンネルを検証し、許可リスト外なら Error を投げる */
  async function resolveAllowedChannel(channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`channel ${channelId} is not allowlisted`);
    }

    const isDM = channel.isDMBased();
    const parentChannelId = channel.isThread() ? channel.parentId : null;
    const recipientFromChannel =
      isDM && 'recipientId' in channel && typeof channel.recipientId === 'string'
        ? channel.recipientId
        : null;
    const dmRecipientId =
      recipientFromChannel ?? (isDM ? dmRecipients.get(channel.id) ?? null : null);

    const cfg = getConfig();
    if (
      !canSendTo(cfg, {
        isDM,
        channelId: channel.id,
        parentChannelId,
        dmRecipientId,
      })
    ) {
      throw new Error(`channel ${channelId} is not allowlisted`);
    }

    if (!channel.isSendable()) {
      throw new Error(`channel ${channelId} is not sendable`);
    }

    return { channel, cfg };
  }

  /** reply の添付ファイルパスを検証し、機密ファイルやサイズ超過を拒否する */
  function validateOutboundFiles(files: string[]): string[] {
    if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE})`);
    }

    const stateReal = tryRealpath(env.stateDir);
    const inboxReal = tryRealpath(join(stateReal, 'inbox'));
    const dotenvReal = tryRealpath(join(REPO_ROOT, '.env'));
    const configReal = tryRealpath(env.configPath);

    const validated: string[] = [];
    for (const filePath of files) {
      let realFile: string;
      try {
        realFile = realpathSync(filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`cannot access file "${filePath}": ${msg}`);
      }

      const normFile = normPathForCompare(realFile);
      if (normFile === normPathForCompare(dotenvReal)) {
        throw new Error(`refusing to send protected file: ${filePath}`);
      }
      if (normFile === normPathForCompare(configReal)) {
        throw new Error(`refusing to send protected file: ${filePath}`);
      }
      if (isSameOrInsideDir(realFile, stateReal) && !isSameOrInsideDir(realFile, inboxReal)) {
        throw new Error(`refusing to send file inside stateDir: ${filePath}`);
      }

      const st = statSync(realFile);
      if (!st.isFile()) {
        throw new Error(`attachment path is not a regular file: ${filePath}`);
      }
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment exceeds 25MB limit: ${filePath}`);
      }

      validated.push(realFile);
    }

    return validated;
  }

  /** 指定チャンネルの直近メッセージを取得し、巡回用の軽量情報と整形済み履歴を同時に返す */
  async function fetchChannelHistory(
    channelId: string,
    rawLimit: number,
  ): Promise<{ lite: MsgLite[]; history: string }> {
    const { channel } = await resolveAllowedChannel(channelId);
    const limit = Math.min(100, Math.max(1, Math.trunc(rawLimit)));
    const fetched = await channel.messages.fetch({ limit });
    if (fetched.size === 0) {
      return { lite: [], history: '(no messages)' };
    }

    const selfId = client.user?.id;
    const sorted = [...fetched.values()].sort((x, y) => x.createdTimestamp - y.createdTimestamp);
    const lite: MsgLite[] = [];
    const lines: string[] = [];

    for (const m of sorted) {
      const isSelf = Boolean(selfId && m.author.id === selfId);
      lite.push({
        id: m.id,
        authorId: m.author.id,
        isSelf,
      });

      let who: string;
      if (isSelf) {
        who = 'me';
      } else {
        const displayName = m.member?.displayName ?? m.author.displayName ?? m.author.username;
        who =
          displayName === m.author.username
            ? m.author.username
            : `${displayName} (${m.author.username})`;
      }

      lines.push(
        formatHistoryLine({
          iso: m.createdAt.toISOString(),
          who,
          content: m.content,
          id: m.id,
          attachmentCount: m.attachments.size,
          replyTo: m.reference?.messageId ?? null,
        }),
      );
    }

    return { lite, history: lines.join('\n') };
  }

  client.on(Events.Error, (err) => {
    console.error(`${jstPrefix()} Discord クライアントエラー:`, err);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      const cfg = getConfig();
      const channel = message.channel;
      const isDM = channel.isDMBased();
      const selfId = client.user?.id;
      const isSelf = Boolean(selfId && message.author.id === selfId);

      // DM チャンネル ID と相手の対応を記憶しておく（fetch 時に recipientId が欠ける場合の補完用）
      if (isDM && !isSelf) {
        dmRecipients.set(message.channelId, message.author.id);
      }

      const parentChannelId = channel.isThread() ? channel.parentId : null;

      let mentioned = false;
      if (selfId && message.mentions.users.has(selfId)) {
        mentioned = true;
      } else if (
        message.reference?.messageId &&
        recentBotIdSet.has(message.reference.messageId)
      ) {
        mentioned = true;
      } else if (matchesMentionPattern(message.content, cfg.mentionPatterns)) {
        mentioned = true;
      }

      const baseFacts: InboundFacts = {
        authorId: message.author.id,
        authorIsBot: message.author.bot,
        isSelf,
        isDM,
        channelId: message.channelId,
        parentChannelId,
        mentioned,
      };

      // 未メンションかつ参照先メッセージがある場合のみ、API fetch 前に他の条件で通るかを事前確認する
      if (!mentioned && message.reference?.messageId && selfId) {
        if (decide(cfg, { ...baseFacts, mentioned: true }) === 'deliver') {
          try {
            const ref = await message.fetchReference();
            if (ref.author.id === selfId) {
              mentioned = true;
            }
          } catch {
            // 参照先メッセージの取得失敗は無視する
          }
        }
      }

      if (decide(cfg, { ...baseFacts, mentioned }) !== 'deliver') {
        return;
      }

      if (cfg.ackReaction) {
        void message.react(cfg.ackReaction).catch(() => {});
      }

      const attachments: AttachmentInfo[] = [...message.attachments.values()].map((att) => ({
        name: att.name ?? 'attachment',
        contentType: att.contentType ?? null,
        sizeBytes: att.size,
      }));
      const displayName =
        message.member?.displayName ?? message.author.displayName ?? message.author.username;

      const formatted = formatInbound({
        chatId: message.channelId,
        messageId: message.id,
        authorName: message.author.username,
        displayName,
        authorId: message.author.id,
        ts: message.createdAt.toISOString(),
        replyToMessageId: message.reference?.messageId ?? null,
        attachments,
        content: message.content,
      });

      if (channel.isSendable()) {
        startTyping(channel);
      }

      inboundHandler?.(formatted, message.channelId);
    } catch (err) {
      console.error(`${jstPrefix()} messageCreate 処理エラー:`, err);
    }
  });

  const tools: DiscordTools = {
    async reply(a) {
      const { channel, cfg } = await resolveAllowedChannel(a.chat_id);
      if (!channel.isSendable()) {
        throw new Error(`channel ${a.chat_id} is not sendable`);
      }

      const validatedFiles = a.files && a.files.length > 0 ? validateOutboundFiles(a.files) : [];
      const rawChunks = splitMessage(a.text, cfg.textChunkLimit, cfg.chunkMode);
      const chunks = rawChunks.length > 0 ? rawChunks : validatedFiles.length > 0 ? [''] : [];
      if (chunks.length === 0) {
        throw new Error('reply text is empty and no files were provided');
      }

      const sentIds: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const shouldReply =
          Boolean(a.reply_to) &&
          (cfg.replyToMode === 'all' || (cfg.replyToMode === 'first' && i === 0));
        const msgOpts: MessageCreateOptions = {
          content: chunks[i],
          ...(shouldReply && a.reply_to
            ? { reply: { messageReference: a.reply_to, failIfNotExists: false } }
            : {}),
          ...(i === 0 && validatedFiles.length > 0 ? { files: validatedFiles } : {}),
        };

        try {
          const sent = await channel.send(msgOpts);
          sentIds.push(sent.id);
          rememberBotMessage(sent.id);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(
            `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${reason}`,
          );
        }
      }

      // 返信を送ったら「入力中…」は止める（webhook モードではターン終了の合図が来ないため、ここで止めないと 2 分続く）
      stopTyping();

      if (sentIds.length === 1) {
        return `sent (id: ${sentIds[0]})`;
      }
      return `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`;
    },

    async react(a) {
      const { channel } = await resolveAllowedChannel(a.chat_id);
      const msg = await channel.messages.fetch(a.message_id);
      await msg.react(a.emoji);
      // リアクションだけで済ませた場合も「入力中…」を止める
      stopTyping();
      return 'reacted';
    },

    async editMessage(a) {
      const { channel } = await resolveAllowedChannel(a.chat_id);
      const msg = await channel.messages.fetch(a.message_id);
      const edited = await msg.edit(a.text);
      return `edited (id: ${edited.id})`;
    },

    async downloadAttachment(a) {
      const { channel } = await resolveAllowedChannel(a.chat_id);
      const msg = await channel.messages.fetch(a.message_id);
      const atts = [...msg.attachments.values()];
      if (atts.length === 0) {
        return 'message has no attachments';
      }

      for (const att of atts) {
        if (att.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`attachment "${att.name ?? att.id}" exceeds 25MB limit`);
        }
      }

      const inboxDir = join(env.stateDir, 'inbox');
      mkdirSync(inboxDir, { recursive: true });

      const lines: string[] = [];
      for (const att of atts) {
        const res = await fetch(att.url);
        if (!res.ok) {
          throw new Error(`failed to download "${att.name ?? att.id}": HTTP ${res.status}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
          throw new Error(`attachment "${att.name ?? att.id}" exceeds 25MB limit`);
        }

        const rawExt = extname(att.name ?? '')
          .replace(/^\./, '')
          .replace(/[^a-zA-Z0-9]/g, '');
        const ext = rawExt || 'bin';
        const destPath = join(inboxDir, `${Date.now()}-${att.id}.${ext}`);
        writeFileSync(destPath, buf);

        const kb = (buf.byteLength / 1024).toFixed(0);
        const type = att.contentType ?? 'unknown';
        const safeName = sanitizeAttachmentName(att.name ?? 'attachment');
        lines.push(`  ${destPath}  (${safeName}, ${type}, ${kb}KB)`);
      }

      return `downloaded ${atts.length} attachment(s):\n${lines.join('\n')}`;
    },

    async fetchMessages(a) {
      const { history } = await fetchChannelHistory(a.channel, a.limit ?? 20);
      return history;
    },

    async listMembers(a) {
      const { channel } = await resolveAllowedChannel(a.channel);
      if (channel.isDMBased() || !('guildId' in channel) || !channel.guildId) {
        throw new Error('list_members is only supported in server channels');
      }
      const guildId = channel.guildId;

      const formatMember = (m: APIGuildMember): string => {
        const username = m.user?.username ?? 'unknown';
        const displayName = m.nick ?? m.user?.global_name ?? username;
        const botTag = m.user?.bot ? ' [BOT]' : '';
        const id = m.user?.id ?? 'unknown';
        return `${displayName} (${username})${botTag}  id: ${id}`;
      };

      if (a.memberId) {
        const member = (await client.rest.get(
          Routes.guildMember(guildId, a.memberId),
        )) as APIGuildMember;
        return formatMember(member);
      }

      const limit = Math.min(1000, Math.max(1, Math.trunc(a.limit ?? 100)));
      try {
        const members = (await client.rest.get(Routes.guildMembers(guildId), {
          query: new URLSearchParams({ limit: String(limit) }),
        })) as APIGuildMember[];
        if (members.length === 0) {
          return '(no members)';
        }
        return members.map(formatMember).join('\n');
      } catch (err) {
        if (err instanceof DiscordAPIError && err.status === 403) {
          throw new Error(
            'Listing guild members requires the SERVER MEMBERS INTENT in Discord Developer Portal (403). You can still look up a single member by passing user_id.',
          );
        }
        throw err;
      }
    },

    async getMessageAuthor(chatId, messageId) {
      await resolveAllowedChannel(chatId);
      if (!/^\d+$/.test(messageId)) {
        throw new Error(`invalid message_id: ${messageId}`);
      }
      const msg = (await client.rest.get(
        Routes.channelMessage(chatId, messageId),
      )) as APIMessage;
      return {
        authorId: msg.author.id,
        content: msg.content ?? '',
      };
    },
  };

  return {
    client,
    tools,
    async login(): Promise<void> {
      const readyPromise = new Promise<void>((resolveReady) => {
        client.once(Events.ClientReady, () => {
          resolveReady();
        });
      });
      await client.login(env.token);
      await readyPromise;
    },
    onInbound(handler: (text: string, chatId: string) => void): void {
      inboundHandler = handler;
    },
    fetchSnapshot(channelId: string, limit = 15): Promise<{ lite: MsgLite[]; history: string }> {
      return fetchChannelHistory(channelId, limit);
    },
    stopTyping,
    async destroy(): Promise<void> {
      stopTyping();
      await client.destroy();
    },
  };
}
