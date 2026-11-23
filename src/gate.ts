import type { BotConfig } from './config.ts';

/** 受信メッセージの判定に必要な情報 */
export type InboundFacts = {
  authorId: string;
  authorIsBot: boolean;
  isSelf: boolean;
  isDM: boolean;
  channelId: string;
  parentChannelId?: string | null;
  mentioned: boolean;
};

/**
 * 受信メッセージをエージェントに渡すか（deliver）、無視するか（drop）を判定する。
 */
export function decide(cfg: BotConfig, f: InboundFacts): 'deliver' | 'drop' {
  // 1. 自分自身の発言は無視
  if (f.isSelf) return 'drop';

  // 2. 他の bot は allowBots に含まれる場合のみ許可
  if (f.authorIsBot && !cfg.allowBots.includes(f.authorId)) return 'drop';

  // 3. DM は dmAllowFrom のみ許可
  if (f.isDM) {
    return cfg.dmAllowFrom.includes(f.authorId) ? 'deliver' : 'drop';
  }

  // 4. サーバーチャンネル（スレッドは親チャンネル ID で引く）
  const key = f.parentChannelId ?? f.channelId;
  if (!Object.hasOwn(cfg.channels, key)) return 'drop';
  const policy = cfg.channels[key];
  if (!policy) return 'drop';

  // 5. チャンネルの allowFrom が空でなければ投稿者を確認
  if (policy.allowFrom && policy.allowFrom.length > 0 && !policy.allowFrom.includes(f.authorId)) {
    return 'drop';
  }

  // 6. requireMention（既定 true）かつ未メンションなら無視
  const requireMention = policy.requireMention ?? true;
  if (requireMention && !f.mentioned) return 'drop';

  return 'deliver';
}

/** 送信先チャンネルの判定情報 */
export type OutboundTarget = {
  isDM: boolean;
  channelId: string;
  parentChannelId?: string | null;
  dmRecipientId?: string | null;
};

/**
 * ツールからの送信・操作対象として許可されたチャンネルか判定する。
 */
export function canSendTo(cfg: BotConfig, t: OutboundTarget): boolean {
  if (t.isDM) {
    return Boolean(t.dmRecipientId && cfg.dmAllowFrom.includes(t.dmRecipientId));
  }
  const key = t.parentChannelId ?? t.channelId;
  return Object.hasOwn(cfg.channels, key);
}

/**
 * 本文が mentionPatterns のいずれか（大文字小文字無視）に一致するか判定する。
 * 不正な正規表現は無視して例外を出さない。
 */
export function matchesMentionPattern(text: string, patterns: string[]): boolean {
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) {
        return true;
      }
    } catch {
      // 不正な正規表現は無視する
    }
  }
  return false;
}
