import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertAccessJson } from '../src/config.ts';

/** このリポジトリのルートディレクトリ（import.meta.url 基準） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function main(): void {
  const args = process.argv.slice(2);
  let force = false;
  let inputArg: string | undefined;

  for (const arg of args) {
    if (arg === '--force') {
      force = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log('使い方: bun scripts/import-access.ts [access.json のパス] [--force]');
      process.exit(0);
    } else if (arg.startsWith('-')) {
      console.error(`不明なオプションです: ${arg}`);
      process.exit(1);
    } else if (inputArg === undefined) {
      inputArg = arg;
    } else {
      console.error(`余分な引数です: ${arg}`);
      process.exit(1);
    }
  }

  const srcPath = inputArg
    ? resolve(inputArg)
    : join(homedir(), '.claude', 'channels', 'discord', 'access.json');

  const rawConfigEnv = process.env.BOT_CONFIG?.trim();
  const destPath = rawConfigEnv ? resolve(REPO_ROOT, rawConfigEnv) : resolve(REPO_ROOT, 'config.json');

  if (existsSync(destPath) && !force) {
    console.error(
      `出力先ファイルが既に存在します: ${destPath}\n上書きするには --force を指定してください。`,
    );
    process.exit(1);
  }

  if (!existsSync(srcPath)) {
    console.error(`入力ファイルが見つかりません: ${srcPath}`);
    process.exit(1);
  }

  const rawText = readFileSync(srcPath, 'utf8');
  const rawJson: unknown = JSON.parse(rawText);
  const config = convertAccessJson(rawJson);

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  console.log(`設定を書き出しました: ${destPath}`);
  console.log(`  チャンネル数: ${Object.keys(config.channels).length}`);
  console.log(`  DM 許可数: ${config.dmAllowFrom.length}`);
  console.log(`  許可 bot 数: ${config.allowBots.length}`);
}

main();
