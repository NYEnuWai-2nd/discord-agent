# discord-agent

`discord.js` を使って単体で動作する Discord ボットです。
2 つの頭脳モード（Claude Agent SDK による自律セッション / webhook + 外部エージェント連携）に対応し、チャンネル・メンバー単位のアクセス制御、メッセージ分割送信、添付ファイルのダウンロード・送信、履歴取得などの機能を備えています。

bot の人格やスキル・ルールはリポジトリ本体ではなく、環境変数 `BOT_WORKSPACE` で指定する任意のワークスペースディレクトリに配置します。

> [!WARNING]
> **Claude Code 側の Discord プラグインと同時に動かさないでください**
> 本ボットは `claude` モード時に `settingSources: ['project', 'local']` を指定してグローバル設定を読み込まないようにしていますが、同じボットトークンで別クライアント（Claude Code の Discord プラグインなど）を同時に起動するとメッセージの二重受信・二重応答が発生します。同じトークンを使う他プロセスは停止してください。

> [!CAUTION]
> **`BOT_PERMISSION_MODE=bypassPermissions` の注意**
> 既定値の `BOT_PERMISSION_MODE=bypassPermissions` では、承認プロンプトなしでワークスペース内のファイル編集やシェルコマンド実行が許可されます。信頼できるチャンネル・メンバーのみを `config.json` に登録し、必要に応じて `default` や `acceptEdits` などより制限の強いモードを検討してください。

---

## 必要環境

- [Bun](https://bun.sh/) 1.3 以上
- Discord Bot トークン（[Discord Developer Portal](https://discord.com/developers/applications) で発行し、**MESSAGE CONTENT INTENT** を有効化）
- ワークスペース用ディレクトリ（空でも可。`CLAUDE.md` や `.claude/skills/` を置くと `claude` モードで自動読込されます）
- `claude` モードを使う場合: Claude Agent SDK が利用できる認証環境（Claude Code のログイン済み環境や `ANTHROPIC_API_KEY` など）

---

## セットアップ

1. 依存関係をインストールします。
   ```bash
   bun install
   ```
2. `.env.example` をコピーして `.env` を作成し、少なくとも `DISCORD_BOT_TOKEN` と `BOT_WORKSPACE` を設定します。
   ```bash
   cp .env.example .env
   ```
   - `DISCORD_BOT_TOKEN`: Discord Developer Portal で取得したボットトークン
   - `BOT_WORKSPACE`: エージェントに作業させるワークスペースディレクトリのパス
3. `config.example.json` をコピーして `config.json` を作成し、許可するチャンネル ID・DM 許可 ID・モード管理者の ID などを設定します。
   ```bash
   cp config.example.json config.json
   ```
   > **補足（Claude Code Discord プラグインからの移行）**: 既存の `access.json`（既定: `~/.claude/channels/discord/access.json`）から変換したい場合は `bun scripts/import-access.ts [access.json のパス] [--force]` も利用できます。
4. ボットを起動します。
   ```bash
   bun run start
   ```
   （または `bun src/main.ts`）

---

## 3 つの頭脳モード（`BOT_BRAIN`）

`BOT_BRAIN` 環境変数で応答を生成する頭脳を切り替えられます。

### 1. Claude Agent SDK モード（`BOT_BRAIN=claude`、既定）

- `@anthropic-ai/claude-agent-sdk` の `query()` を `BOT_WORKSPACE` をカレントディレクトリとして常駐実行します。
- 受信メッセージはインプロセス MCP サーバー（`plugin_discord_discord`）経由でモデルに渡され、応答・リアクション・履歴取得などを行います。
- セッション ID は `.state/session.json` に保存され、再起動やエラー復旧時に自動再開します（`BOT_FRESH_SESSION=1` で初回のみ新規開始）。

### 2. webhook + 外部エージェントモード（`BOT_BRAIN=webhook`）

- bot プロセス自体は LLM を呼ばず、Discord の送受信・アクセス制御・ローカル HTTP ツールサーバー（`127.0.0.1:<port>`）・定期巡回（`BOT_PATROL_MINUTES`）を担当します。
- 受信メッセージや巡回スナップショットは `.state/pending/` に JSON として保存され、`BOT_WEBHOOK_URL` へ通知（`POST`）を送ります。
- 外部エージェント（例: T3 Code の予約タスクで動く Gemini など）は `scripts/take.ts` で受信を 1 件ずつ取り出し、`scripts/tool.ts` 経由で返信や各種操作を実行します。
- `take.ts --wait <秒>` で待ち受け中は `.state/resident.json` に心拍が記録され、その間の冗長な webhook 通知を省略します。
- 外部エージェントに与える指示書のひな形は [GEMINI_BRAIN.md](GEMINI_BRAIN.md) を参照してください。

### 3. ACP モード（`BOT_BRAIN=acp`）

- ACP（Agent Client Protocol）対応のエージェントを bot 自身が子プロセスとして起動し、1 つのセッションを開いたまま、着信・巡回ごとに `session/prompt` を直列に送ります（JSON-RPC 2.0 over stdio を自前実装。外部ライブラリ不要）。
- エージェントは webhook モードと同じく、ローカル HTTP ツールサーバー経由で `scripts/tool.ts` を実行して返信・リアクションを行います。権限確認（`session/request_permission`）には bot が自動で許可を返します。
- セッション ID は `.state/acp-session.json` に保存され、エージェントが `session/resume` / `session/load` に対応していれば再起動後も会話を引き継ぎます。子プロセスが落ちたら間隔を空けて自動で再起動します。
- 起動中に `tool.ts list_models` / `set_model` でモデル（エフォート）を切り替えられます（`set_model` は `modeAdmins` のメッセージのみ受け付け、選んだモデルは `.state/acp-model.json` に保存）。
- `BOT_ACP_COMMAND` の例:
  - Antigravity: `agy acp`
  - Gemini CLI: `gemini --experimental-acp`
  - Claude Code: `npx -y @agentclientprotocol/claude-agent-acp`
  - OpenCode: `opencode acp`
- Discord に接続せずに疎通だけ確かめるには: `BOT_ACP_COMMAND="agy acp" bun scripts/acp-smoke.ts`

---

## 環境変数

| 変数名 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `DISCORD_BOT_TOKEN` | 必須 | — | Discord ボットのトークン（`smoke.ts` では不要） |
| `BOT_WORKSPACE` | 必須 | — | エージェントの作業ディレクトリ（存在するディレクトリを指定） |
| `BOT_BRAIN` | 任意 | `claude` | 頭脳モード（`claude` / `webhook` / `acp`） |
| `BOT_WEBHOOK_URL` | `webhook` 時必須 | — | `BOT_BRAIN=webhook` 時に起床通知を送る URL |
| `BOT_MODEL` | 任意 | SDK 既定 | `claude` モードで使用するモデル名 |
| `BOT_PERMISSION_MODE` | 任意 | `bypassPermissions` | SDK の権限モード（`default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto`） |
| `BOT_STATE_DIR` | 任意 | `.state` | セッション情報・受信添付ファイル・キュー等の保存先 |
| `BOT_CONFIG` | 任意 | `config.json` | 許可設定 JSON ファイルのパス（変更時は mtime を見て自動再読込） |
| `BOT_FRESH_SESSION` | 任意 | 未設定 (`0`) | `1` を指定すると初回起動時のみ保存済みセッションを引き継がず新規開始 |
| `BOT_PATROL_MINUTES` | 任意 | `0` | `webhook` / `acp` モード時の定期巡回間隔（分）。`0` または未設定で無効、有効時は `1` 以上 |
| `BOT_ACP_COMMAND` | `acp` 時必須 | — | 子プロセスとして起動する ACP エージェントのコマンド |
| `BOT_ACP_CWD` | 任意 | `BOT_WORKSPACE` | ACP エージェントの作業ディレクトリ |
| `BOT_ACP_MODEL` | 任意 | エージェント既定 | 起動時に指定するモデル ID（エージェントが返した一覧にある場合のみ適用） |
| `BOT_ACP_INSTRUCTIONS` | 任意 | `<repo>/GEMINI_BRAIN.md` | 新規セッションの最初に読ませる指示書の絶対パス |
| `BOT_ACP_PROMPT_TIMEOUT_SEC` | 任意 | `300` | 1 ターンのタイムアウト秒数（超えたら `session/cancel`） |
| `BOT_ACP_MAX_TURNS` | 任意 | `200` | セッションを作り直すまでのターン数 |
| `BOT_JOURNAL_TIME` | 任意 | `23:55` | `webhook` / `acp` モードで日誌を書く毎日の時刻（`HH:MM`、JST）。空文字で無効 |
| `BOT_JOURNAL_ON_EXIT` | 任意 | `1` | `acp` モードの終了時（SIGINT / SIGTERM）に日誌を書いてから終了するか（`0` で無効） |
| `BOT_JOURNAL_EXIT_TIMEOUT_SEC` | 任意 | `120` | 終了時の日誌を待つ最大秒数 |

---

## 日誌機能（webhook / acp モード）

`BOT_BRAIN=webhook` または `BOT_BRAIN=acp` のとき、巡回対象チャンネル（`patrolChannels`、未設定時は `channels` 全体）の直近発言をまとめ、`{workspace}/Context/日誌/YYYY-MM-DD.md` へ `write_journal` ツールで記録します（`BOT_BRAIN=claude` では無効）。

- **毎日の定時日誌（`BOT_JOURNAL_TIME`）**: 既定 `23:55`（JST）。前回記録時刻（`{stateDir}/journal-last.json` の `at`、無ければ当日の JST 0 時）以降の新規発言がある場合のみ日誌依頼を出します。スリープ等で定時を過ぎた場合、1 時間以内であれば復帰時に実行し、1 時間超遅れた場合はその日を飛ばします。空文字を指定すると無効になります。
- **終了時日誌（`BOT_BRAIN=acp` のみ、`BOT_JOURNAL_ON_EXIT`）**: `1`（既定）のとき、SIGINT / SIGTERM 受信時に巡回・新規受信を止めた上で終了前日誌をキューへ入れ、処理完了まで最大 `BOT_JOURNAL_EXIT_TIMEOUT_SEC` 秒（既定 `120`）待機してから終了します（新規発言が 0 件なら待たずに終了、待機中に再度シグナルを送ると即終了）。

---

## `config.json` の各項目

```json
{
  "channels": {
    "123456789012345678": {
      "requireMention": true,
      "allowFrom": ["987654321098765432"]
    }
  },
  "dmAllowFrom": ["987654321098765432"],
  "allowBots": [],
  "mentionPatterns": ["\\bbot\\b"],
  "ackReaction": "👀",
  "replyToMode": "first",
  "chunkMode": "newline",
  "textChunkLimit": 2000,
  "patrolChannels": [],
  "modeAdmins": ["987654321098765432"]
}
```

| 項目 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `channels` | `Record<string, ChannelPolicy>` | `{}` | 許可するサーバーチャンネル ID ごとの設定。スレッド内のメッセージは親チャンネル ID で判定されます。 |
| `channels.<id>.requireMention` | `boolean` | `true` | `true` の場合、ボットへのメンション・ボット発言への返信・`mentionPatterns` 一致のいずれかに該当したときだけ応答します。 |
| `channels.<id>.allowFrom` | `string[]` | `[]` | 空でない場合、この配列に含まれるアカウント ID の発言のみ受け付けます。空なら全員許可。 |
| `dmAllowFrom` | `string[]` | `[]` | DM の送受信を許可するアカウント ID の配列。空の場合は DM を受け付けません。 |
| `allowBots` | `string[]` | `[]` | 発言を受け付ける他ボットのアカウント ID 一覧（自分自身の発言は常に無視されます）。 |
| `mentionPatterns` | `string[]` | `[]` | 本文が一致したときにメンション扱いとする正規表現文字列（大文字小文字無視、不正な正規表現は無視）。 |
| `ackReaction` | `string` (任意) | 未設定 | 受信メッセージを受け付けた際に即座に付ける絵文字リアクション（失敗時は無視）。 |
| `replyToMode` | `'off' \| 'first' \| 'all'` | `'first'` | `reply` ツールで `reply_to` が渡されたとき、返信参照を付けない (`off`) / 最初のチャンクのみ (`first`) / 全チャンク (`all`) を指定します。 |
| `chunkMode` | `'length' \| 'newline'` | `'newline'` | 送信メッセージ分割モード。`newline` は改行位置を優先して分割、連続改行を除去します。 |
| `textChunkLimit` | `number` | `2000` | 1 メッセージあたりの最大文字数（`1`〜`2000` に丸められます）。 |
| `patrolChannels` | `string[]` | `[]` | 定期巡回（`BOT_PATROL_MINUTES`）の対象とするチャンネル ID の配列。空なら `channels` の全キーを巡回します（指定時は `channels` にも含まれる ID のみ対象）。 |
| `modeAdmins` | `string[]` | `[]` | `set_state` ツールによる状態切り替えを許可する Discord アカウント ID の配列。 |

> [!NOTE]
> `list_members` ツールでサーバー内のメンバー一覧を取得するには Discord Developer Portal で **SERVER MEMBERS INTENT** を有効にする必要があります（Gateway 接続自体は `GuildMembers` intent を使わないため未許可でも起動します）。

---

## ツール一覧

`claude` モードでは内蔵 MCP サーバー（`plugin_discord_discord`）から、また `webhook` モードでは `bun scripts/tool.ts <tool_name> ...` 経由で以下のツールを呼び出せます。

### Discord 操作ツール（両モード共通）

| ツール名 | 主な用途 | 制限・補足 |
| --- | --- | --- |
| `reply` | メッセージ送信・返信（`--files` でファイル添付可） | `textChunkLimit` に従い自動分割。添付は最初の 1 通のみ（最大 10 個・各 25MB まで）。`.env` / `config.json` / `inbox/` 外の `stateDir` ファイルは送信不可 |
| `react` | 指定メッセージへの絵文字リアクション追加 | 許可済みチャンネルのみ対象 |
| `edit_message` | bot 自身が送ったメッセージの編集 | 許可済みチャンネルのみ対象 |
| `download_attachment` | 添付ファイルを `{stateDir}/inbox/` へ保存 | 1 ファイル最大 25MB |
| `fetch_messages` | チャンネルの直近履歴を取得 | 既定 20 件、最大 100 件（検索 API なし） |
| `list_members` | サーバーメンバー一覧または指定 ID の 1 人を取得 | サーバー内チャンネル専用。一覧は Server Members Intent が必要（`user_id` 指定の単体取得は不要） |

### ワークスペース連携ツール（`tool.ts` / ローカルツールサーバー専用）

| ツール名 | 主な用途 | 制限・補足 |
| --- | --- | --- |
| `set_state` | `{workspace}/現在の状態.md` の指定キーを更新 | 指示メッセージの送信者が `modeAdmins` に含まれる場合のみ実行可。キーが `ペルソナ` のときは `{workspace}/ペルソナ/<名前>.md` の存在を確認 |
| `add_person` | `{workspace}/Context/人物一覧.csv` に新規行を追加 | 重複 ID/名前を拒否。名前 50 字・解説 400 字まで |
| `note_person` | `{workspace}/Context/人物一覧.csv` の既存人物の解説へ追記 | 日付自動付与。追記 150 字まで |

---

## テスト・スモークチェックの実行方法

- **型チェック (`tsc --noEmit`)**
  ```bash
  bun run check
  ```
- **単体テスト (`bun test`)**
  ```bash
  bun test
  ```
- **スモークテスト (`scripts/smoke.ts`)**
  Discord に接続せず、ワークスペースの `CLAUDE.md` 読み込み・スキル解決・ダミー MCP ツール登録のみを確認します（`DISCORD_BOT_TOKEN` 不要、`BOT_WORKSPACE` のみ必要）。
  ```bash
  bun run smoke
  ```

---

## ライセンス

[MIT License](LICENSE)
