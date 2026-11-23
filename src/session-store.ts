import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 保存済みのセッション ID を `{stateDir}/session.json` から読み出す。
 * ファイルが存在しない・壊れている・sessionId が文字列でない場合は undefined を返す。
 */
export function loadSessionId(stateDir: string): string | undefined {
  try {
    const raw = readFileSync(join(stateDir, 'session.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const sessionId = (parsed as Record<string, unknown>).sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * セッション ID を `{stateDir}/session.json` に保存する。
 * ディレクトリが存在しない場合は再帰的に作成する。
 */
export function saveSessionId(stateDir: string, sessionId: string): void {
  mkdirSync(stateDir, { recursive: true });
  const payload = {
    sessionId,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(join(stateDir, 'session.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
}
