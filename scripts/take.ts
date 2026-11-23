/**
 * 未処理の受信メッセージを 1 件取り出して表示する（Gemini を頭脳にするときの受信手段）。
 *
 *   bun scripts/take.ts            # 今あるものを 1 件。無ければすぐ終わる
 *   bun scripts/take.ts --wait 120 # 最大 120 秒、新着を待つ（常駐用）
 *
 * - bot（BOT_BRAIN=webhook）が {stateDir}/pending/ に置いた JSON を、古い順に 1 件取る。
 * - 取った分は {stateDir}/taken/ に移す（rename なので、同時に複数の実行が走っても同じ 1 件を二重に取らない）。
 * - 何も無ければ（--wait なら待ち切っても無ければ）「(no pending messages)」と表示する。
 * - --wait 中は {stateDir}/resident.json に心拍（時刻）を書く。bot はこれが新しい間、webhook を省く。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// このリポジトリの .env から BOT_STATE_DIR だけ読む
let stateDirSetting = process.env.BOT_STATE_DIR;
if (stateDirSetting === undefined) {
  try {
    const m = /^BOT_STATE_DIR=(.*)$/m.exec(readFileSync(join(REPO_ROOT, '.env'), 'utf8'));
    if (m && m[1]!.trim()) stateDirSetting = m[1]!.trim();
  } catch {
    // .env が無ければ既定値
  }
}
const stateDir = resolve(REPO_ROOT, stateDirSetting || '.state');
const pendingDir = join(stateDir, 'pending');
const takenDir = join(stateDir, 'taken');
const heartbeatFile = join(stateDir, 'resident.json');
mkdirSync(takenDir, { recursive: true });

// --wait <秒>（上限 300 秒。コマンドの実行時間制限に引っかからないよう長くしすぎない）
const waitIdx = process.argv.indexOf('--wait');
const waitSec = waitIdx !== -1 ? Math.min(300, Math.max(0, Number(process.argv[waitIdx + 1]) || 0)) : 0;
const deadline = Date.now() + waitSec * 1000;

function heartbeat(): void {
  try {
    writeFileSync(heartbeatFile, JSON.stringify({ at: Date.now(), pid: process.pid }));
  } catch {
    // 心拍が書けなくても受信処理は続ける
  }
}

/** 1 件取り出して表示できたら true */
function tryTake(): boolean {
  let files: string[] = [];
  try {
    files = readdirSync(pendingDir).filter(f => f.endsWith('.json')).sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    const dest = join(takenDir, f);
    try {
      renameSync(join(pendingDir, f), dest);
    } catch {
      continue; // 別の実行が先に取った
    }
    const data = JSON.parse(readFileSync(dest, 'utf8')) as {
      kind?: string;
      inbound?: string;
      history?: string;
      channels?: Array<{ chatId?: string; history?: string }>;
    };
    console.log(`残り: ${files.length - files.indexOf(f) - 1} 件`);
    if (data.kind === 'patrol') {
      console.log('=== patrol ===');
      for (const ch of data.channels ?? []) {
        console.log(`--- chat_id=${ch.chatId ?? ''} ---`);
        console.log(ch.history ?? '');
      }
    } else {
      console.log('=== inbound ===');
      console.log(data.inbound ?? '');
      console.log('=== history（古い順。me は bot 自身） ===');
      console.log(data.history ?? '');
    }
    return true;
  }
  return false;
}

if (waitSec > 0) heartbeat();
while (true) {
  if (tryTake()) {
    // 取り出した直後も心拍を更新しておく（処理中に webhook が飛ばないように）
    if (waitSec > 0) heartbeat();
    process.exit(0);
  }
  if (Date.now() >= deadline) break;
  heartbeat();
  await Bun.sleep(1000);
}

console.log('(no pending messages)');
