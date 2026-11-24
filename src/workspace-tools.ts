import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BotConfig } from './config.ts';
import type { DiscordTools } from './discord.ts';

/** 1 行ごとの内容と元の改行文字のペア */
type LineSegment = {
  line: string;
  eol: string;
};

/** CSV の 1 レコード（元文字列・改行・空行フラグを保持する） */
export type CsvRecord = {
  fields: string[];
  rawRecord: string;
  eol: string;
  isBlank: boolean;
};

/** Date を JST (UTC+9) の各要素に分解する */
function toJstParts(now: Date): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
} {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return {
    year: String(jst.getUTCFullYear()),
    month: pad2(jst.getUTCMonth() + 1),
    day: pad2(jst.getUTCDate()),
    hour: pad2(jst.getUTCHours()),
    minute: pad2(jst.getUTCMinutes()),
  };
}

/** JST の `YYYY-MM-DD HH:MM` 文字列を返す */
export function formatJstDateTime(now: Date = new Date()): string {
  const p = toJstParts(now);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** JST の `YYYY-MM-DD` 文字列を返す */
export function formatJstDate(now: Date = new Date()): string {
  const p = toJstParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 一時ファイル経由で原子的に UTF-8 ファイルを書き込む */
export function writeFileAtomic(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // クリーンアップ失敗は無視
    }
    throw err;
  }
}

/** 元の改行コードを保ったまま行配列へ分解する */
function splitLinesPreservingEol(content: string): LineSegment[] {
  const segments: LineSegment[] = [];
  let pos = 0;
  while (pos < content.length) {
    const match = /\r\n|\n|\r/.exec(content.slice(pos));
    if (!match) {
      segments.push({ line: content.slice(pos), eol: '' });
      break;
    }
    const eolStart = pos + match.index;
    segments.push({
      line: content.slice(pos, eolStart),
      eol: match[0],
    });
    pos = eolStart + match[0].length;
  }
  return segments;
}

/** ペルソナ設定値から先頭のペルソナ名（最初の「（」または空白より前）を取り出す */
export function extractPersonaName(value: string): string {
  const name = value.split(/[\s（]/, 1)[0] ?? '';
  if (
    !name ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..'
  ) {
    throw new Error(`ペルソナ名が不正です: ${value}`);
  }
  return name;
}

/** set_state 用の入力値検証 */
export function validateStateInput(key: string, value: string): void {
  if (!key || /[\r\n]/.test(key)) {
    throw new Error('key が不正です');
  }
  if (/[\r\n]/.test(value)) {
    throw new Error('value に改行を含めることはできません');
  }
  if (value.trim().length === 0) {
    throw new Error('value を指定してください');
  }
  if (value.length > 200) {
    throw new Error('value は 200 文字以内にしてください');
  }
}

/**
 * `現在の状態.md` の内容からトップレベル `- <key>: ...` 行を探し、値を置換した新しい文字列を返す。
 * 字下げされたサブ行や他の行・改行コードは変更しない。
 */
export function applyStateUpdate(
  content: string,
  key: string,
  value: string,
  now: Date = new Date(),
): { nextContent: string; formattedValue: string } {
  validateStateInput(key, value);

  const formattedValue = `${value}（Discord 指示 ${formatJstDateTime(now)} JST）`;
  const segments = splitLinesPreservingEol(content);
  let matched = false;

  const nextSegments = segments.map((seg) => {
    if (seg.line.startsWith('- ')) {
      const rest = seg.line.slice(2);
      const colonIdx = rest.indexOf(':');
      if (colonIdx !== -1) {
        const lineKey = rest.slice(0, colonIdx);
        if (lineKey === key) {
          matched = true;
          return { line: `- ${key}: ${formattedValue}`, eol: seg.eol };
        }
      }
    }
    return seg;
  });

  if (!matched) {
    throw new Error(`指定されたキーが見つかりません: ${key}`);
  }

  return {
    nextContent: nextSegments.map((s) => s.line + s.eol).join(''),
    formattedValue,
  };
}

/** CSV フィールドを RFC 4180 規則に従ってエスケープする */
export function escapeCsvField(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * クォート内のカンマ・改行・エスケープ済み `""` に対応した簡易 CSV パーサー。
 * 各レコードの元文字列（rawRecord）と改行（eol）を保持する。
 */
export function parseCsvRecords(content: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let i = 0;
  const len = content.length;

  while (i < len) {
    const recordStart = i;

    if (content[i] === '\r' || content[i] === '\n') {
      const eol = content[i] === '\r' && content[i + 1] === '\n' ? '\r\n' : content[i]!;
      i += eol.length;
      records.push({ fields: [], rawRecord: '', eol, isBlank: true });
      continue;
    }

    const fields: string[] = [];
    let recordEnd = i;
    let eol = '';

    while (true) {
      if (i < len && content[i] === '"') {
        i++;
        let val = '';
        let closed = false;
        while (i < len) {
          const ch = content[i]!;
          if (ch === '"') {
            if (content[i + 1] === '"') {
              val += '"';
              i += 2;
            } else {
              i++;
              closed = true;
              break;
            }
          } else {
            val += ch;
            i++;
          }
        }
        if (!closed) {
          throw new Error('CSV のクォートが閉じられていません');
        }
        fields.push(val);
        if (i < len && content[i] === ',') {
          i++;
          continue;
        }
        if (i < len && content[i] !== '\r' && content[i] !== '\n') {
          throw new Error('CSV のクォート後の書式が不正です');
        }
      } else {
        let val = '';
        while (i < len && content[i] !== ',' && content[i] !== '\r' && content[i] !== '\n') {
          val += content[i]!;
          i++;
        }
        fields.push(val);
        if (i < len && content[i] === ',') {
          i++;
          continue;
        }
      }

      recordEnd = i;
      if (i < len && (content[i] === '\r' || content[i] === '\n')) {
        eol = content[i] === '\r' && content[i + 1] === '\n' ? '\r\n' : content[i]!;
        i += eol.length;
      }
      break;
    }

    records.push({
      fields,
      rawRecord: content.slice(recordStart, recordEnd),
      eol,
      isBlank: false,
    });
  }

  return records;
}

/** ヘッダー行 `名前,user_id,解説` を検証し、それ以降のデータ行配列を返す */
function extractDataRecords(records: CsvRecord[]): CsvRecord[] {
  const headerIdx = records.findIndex((r) => !r.isBlank);
  if (headerIdx === -1) {
    throw new Error('人物一覧 CSV にヘッダー行がありません');
  }
  const header = records[headerIdx]!.fields;
  if (header[0] !== '名前' || header[1] !== 'user_id' || header[2] !== '解説') {
    throw new Error('人物一覧 CSV のヘッダーが「名前,user_id,解説」と一致しません');
  }
  return records.slice(headerIdx + 1).filter((r) => !r.isBlank);
}

/**
 * 人物 CSV の末尾に新しい 1 行を追加する（純粋関数）。
 * 既存の改行コード・末尾改行の有無を引き継ぐ。
 */
export function appendPersonToCsv(
  content: string,
  args: { name: string; user_id: string; description: string },
): string {
  if (args.name.trim().length === 0) {
    throw new Error('name を指定してください');
  }
  if (args.name.length > 50) {
    throw new Error('name は 50 文字以内にしてください');
  }
  if (args.user_id !== '不明' && !/^\d+$/.test(args.user_id)) {
    throw new Error('user_id は数字の Discord ID または「不明」を指定してください');
  }
  if (args.description.trim().length === 0) {
    throw new Error('description を指定してください');
  }
  if (args.description.length > 400) {
    throw new Error('description は 400 文字以内にしてください');
  }

  const records = parseCsvRecords(content);
  const dataRecords = extractDataRecords(records);

  for (const rec of dataRecords) {
    const rowName = rec.fields[0] ?? '';
    const rowId = rec.fields[1] ?? '';
    if (args.user_id !== '不明') {
      if (rowId === args.user_id) {
        throw new Error(`既に登録済み: ${rowName}`);
      }
    } else if (rowName === args.name) {
      throw new Error(`既に登録済み: ${rowName}`);
    }
  }

  const eol = records.find((r) => r.eol !== '')?.eol ?? '\r\n';
  const hasTrailingNewline = records.length > 0 && records[records.length - 1]!.eol !== '';
  const newRow = [
    escapeCsvField(args.name),
    escapeCsvField(args.user_id),
    escapeCsvField(args.description),
  ].join(',');

  return hasTrailingNewline ? `${content}${newRow}${eol}` : `${content}${eol}${newRow}`;
}

/**
 * 人物 CSV から `user_id` が一致する行を探し、解説の末尾に追記する（純粋関数）。
 * 変更していない行は元の文字列のまま保つ。
 */
export function appendNoteToPersonCsv(
  content: string,
  args: { user_id: string; note: string },
  now: Date = new Date(),
): { nextContent: string; name: string } {
  if (!/^\d+$/.test(args.user_id)) {
    throw new Error('user_id は数字の Discord ID を指定してください');
  }
  if (/[\r\n]/.test(args.note)) {
    throw new Error('note に改行を含めることはできません');
  }
  if (args.note.trim().length === 0) {
    throw new Error('note を指定してください');
  }
  if (args.note.length > 150) {
    throw new Error('note は 150 文字以内にしてください');
  }

  const records = parseCsvRecords(content);
  const dataRecords = extractDataRecords(records);
  const target = dataRecords.find((r) => (r.fields[1] ?? '') === args.user_id);
  if (!target) {
    throw new Error(`該当する人物が見つかりません: ${args.user_id}`);
  }

  const rowName = target.fields[0] ?? '';
  const rowId = target.fields[1] ?? '';
  const currentDesc = target.fields[2] ?? '';
  const suffix = `${args.note}（${formatJstDate(now)} 追記）`;
  const updatedDesc =
    currentDesc === ''
      ? suffix
      : currentDesc.endsWith('。')
        ? `${currentDesc}${suffix}`
        : `${currentDesc}。${suffix}`;

  target.rawRecord = [
    escapeCsvField(rowName),
    escapeCsvField(rowId),
    escapeCsvField(updatedDesc),
  ].join(',');

  return {
    nextContent: records.map((r) => r.rawRecord + r.eol).join(''),
    name: rowName,
  };
}

/**
 * `set_state` を実行する: 送信者権限を確認し、`{workspace}/現在の状態.md` を原子的書き込みで更新する。
 */
export async function setState(
  deps: {
    tools: DiscordTools;
    workspace: string;
    getConfig: () => BotConfig;
    now?: Date;
  },
  args: { chat_id: string; message_id: string; key: string; value: string },
): Promise<string> {
  validateStateInput(args.key, args.value);

  const { authorId } = await deps.tools.getMessageAuthor(args.chat_id, args.message_id);
  const cfg = deps.getConfig();
  if (!cfg.modeAdmins.includes(authorId)) {
    throw new Error('切り替え権限がありません');
  }

  if (args.key === 'ペルソナ') {
    const personaName = extractPersonaName(args.value);
    const personaPath = join(deps.workspace, 'ペルソナ', `${personaName}.md`);
    let exists = false;
    try {
      exists = statSync(personaPath).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      throw new Error(`ペルソナファイルが見つかりません: ${personaName}.md`);
    }
  }

  const statePath = join(deps.workspace, '現在の状態.md');
  const current = readFileSync(statePath, 'utf8');
  const { nextContent, formattedValue } = applyStateUpdate(current, args.key, args.value, deps.now);
  writeFileAtomic(statePath, nextContent);
  return `更新: ${args.key}: ${formattedValue}`;
}

/**
 * `add_person` を実行する: `{workspace}/Context/人物一覧.csv` に新規行を追加して原子的に書き込む。
 */
export async function addPerson(
  deps: { workspace: string },
  args: { name: string; user_id: string; description: string },
): Promise<string> {
  const csvPath = join(deps.workspace, 'Context', '人物一覧.csv');
  const current = readFileSync(csvPath, 'utf8');
  const nextContent = appendPersonToCsv(current, args);
  writeFileAtomic(csvPath, nextContent);
  return `追加: ${args.name} (${args.user_id})`;
}

/**
 * `note_person` を実行する: `{workspace}/Context/人物一覧.csv` の既存人物の解説に追記して原子的に書き込む。
 */
export async function notePerson(
  deps: { workspace: string; now?: Date },
  args: { user_id: string; note: string },
): Promise<string> {
  const csvPath = join(deps.workspace, 'Context', '人物一覧.csv');
  const current = readFileSync(csvPath, 'utf8');
  const { nextContent, name } = appendNoteToPersonCsv(current, args, deps.now);
  writeFileAtomic(csvPath, nextContent);
  return `追記: ${name} (${args.user_id})`;
}

/** 日誌用日付を検証して `YYYY-MM-DD` を返す（省略時は JST の今日） */
export function resolveJournalDate(date: string | undefined, now: Date = new Date()): string {
  const today = formatJstDate(now);
  const target = date ?? today;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(target);
  if (!match) {
    throw new Error(`date の形式が不正です（YYYY-MM-DD）: ${target}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() + 1 !== month || dt.getUTCDate() !== day) {
    throw new Error(`存在しない日付です: ${target}`);
  }
  if (target > today) {
    throw new Error(`未来の日付は指定できません: ${target}`);
  }
  return target;
}

/**
 * 日誌ファイル（`Context/日誌/<date>.md`）の新しい内容を生成する（純粋関数）。
 * 既存内容が無ければ `# 日誌 <date>` 見出しを先頭に付け、`## HH:MM（JST）` 節を追記する。
 */
export function buildJournalContent(
  existingContent: string | null | undefined,
  args: { text: string; date?: string },
  now: Date = new Date(),
): { nextContent: string; date: string } {
  if (typeof args.text !== 'string' || args.text.trim().length === 0) {
    throw new Error('text を指定してください');
  }
  if (args.text.length > 6000) {
    throw new Error('text は 6000 文字以内にしてください');
  }

  const targetDate = resolveJournalDate(args.date, now);
  const parts = toJstParts(now);
  const heading = `## ${parts.hour}:${parts.minute}（JST）`;
  const body = args.text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const entry = `${heading}\n\n${body}\n\n`;

  if (!existingContent) {
    return {
      nextContent: `# 日誌 ${targetDate}\n\n${entry}`,
      date: targetDate,
    };
  }

  let separator = '\n\n';
  if (existingContent.endsWith('\r\n\r\n') || existingContent.endsWith('\n\n')) {
    separator = '';
  } else if (existingContent.endsWith('\r\n') || existingContent.endsWith('\n')) {
    separator = '\n';
  }

  return {
    nextContent: `${existingContent}${separator}${entry}`,
    date: targetDate,
  };
}

/**
 * `write_journal` を実行する: `{workspace}/Context/日誌/<date>.md` に原子的に追記する。
 */
export async function writeJournal(
  deps: { workspace: string; now?: Date },
  args: { text: string; date?: string },
): Promise<string> {
  const now = deps.now ?? new Date();
  const targetDate = resolveJournalDate(args.date, now);
  const journalPath = join(deps.workspace, 'Context', '日誌', `${targetDate}.md`);

  let existing: string | null = null;
  try {
    existing = readFileSync(journalPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  const { nextContent } = buildJournalContent(existing, args, now);
  writeFileAtomic(journalPath, nextContent);
  return `日誌に追記: Context/日誌/${targetDate}.md`;
}
