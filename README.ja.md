# ClawMeeting - マルチプラットフォーム会議スケジューラー

![Version](https://img.shields.io/badge/version-2.0-blue)
![Platform](https://img.shields.io/badge/platform-Feishu%20%7C%20Slack-green)
![License](https://img.shields.io/badge/license-Private-red)
![Tools](https://img.shields.io/badge/tools-7-orange)
![Status](https://img.shields.io/badge/status-production-brightgreen)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | **日本語** | [한국어](./README.ko.md)

---

## 概要

ClawMeeting は OpenClaw 向けの AI 搭載会議スケジューリングシステムです。自然言語を通じて Feishu と Slack をまたぐ複数参加者の会議を調整し、インテリジェントなタイムスロットスコアリング、3フェーズネゴシエーション、自動委任、デバウンス制御によるファイナライズを備えています。

本リポジトリには2つの実装が含まれています:
- **Plugin (v1.0)** — 初代プロダクション版。CommonJS モノレポ構成、`claw-meeting-shared` パッケージを使用。
- **Skill (v2.0)** — 自己完結型の ESM 再実装。ファイルベースの永続化に対応。

両バージョンとも **Feishu + Slack デュアルプラットフォームルーティング**、**7つのツール**、**同一のビジネスロジック** をサポートしています。

---

# Part 1: Plugin バージョン (v1.0)

## Plugin アーキテクチャ

Plugin はモノレポ構成を採用しています。コアのスケジューリングロジックは `shared/` パッケージ (`claw-meeting-shared`) に配置され、プラットフォーム固有のプロバイダーとエントリーポイントは別ディレクトリに分離されています。

```mermaid
graph TD
    subgraph "モノレポ構成"
        SHARED(shared / claw-meeting-shared)
        UNI(unified / index.ts)
        FEI(feishu / index.ts)
        SLK(slack / index.ts)
    end

    UNI -->|import| SHARED
    FEI -->|import| SHARED
    SLK -->|import| SHARED

    SHARED --> CORE(plugin-core.ts)
    CORE --> TOOLS(登録済みツール 7個)
    CORE --> SCHED(scheduler.ts)
    CORE --> STATE(インメモリ State Map)

    style SHARED fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style CORE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style STATE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### Plugin エントリーポイント

| エントリー | パス | 用途 |
|---|---|---|
| **unified** | `unified/src/index.ts` | マルチプラットフォーム (Feishu + Slack)。本番デフォルト。 |
| **feishu** | `feishu/src/index.ts` | Feishu 専用デプロイ |
| **slack** | `slack/src/index.ts` | Slack 専用デプロイ |

3つとも `claw-meeting-shared` をインポートし、プラットフォーム固有の設定で `createMeetingPlugin()` を呼び出します。

### Plugin プラットフォームルーティング

```mermaid
graph LR
    MSG(ユーザーメッセージ) --> GW(OpenClaw ゲートウェイ)
    GW --> AGENT(エージェント LLM)
    AGENT -->|tool call| CORE(plugin-core.ts)
    CORE --> CTX(resolveCtx - ctx.messageChannel)
    CTX -->|feishu| LP(LarkCalendarProvider)
    CTX -->|slack| SP(SlackProvider)
    LP --> LAPI(Feishu Calendar API)
    LP --> LDIR(Feishu Contact API)
    LP --> LDM(Feishu IM API)
    SP --> SDIR(Slack users.list API)
    SP --> SDM(Slack chat.postMessage)

    style CTX fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style LP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style SP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

### Plugin 会議フロー

Plugin を通じたステップバイステップのデータフロー:

```mermaid
graph TD
    A(1. ユーザーが Feishu/Slack でメッセージを送信) --> B(2. ゲートウェイがエージェント LLM にディスパッチ)
    B --> C(3. LLM がインテントを認識し find_and_book_meeting を呼び出し)
    C --> D(4. resolveCtx が ctx.messageChannel からプラットフォームを検出)
    D --> E(5. normalizeAttendees がプラットフォームルールに従い ID を検証)
    E --> F(6. provider.resolveUsers がディレクトリに対して名前を解決)
    F --> G(7. インフライト重複排除 レイヤー1 - Promise 共有)
    G --> H(8. 解決後の冪等性チェック レイヤー2 - SHA256 60秒ウィンドウ)
    H --> I(9. インメモリ Map に PendingMeeting を作成)
    I --> J(10. provider.sendTextDM で各参加者に招待を送信)
    J --> K(11. meetingId を LLM に返却、LLM がユーザーに返信)

    style D fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style G fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style H fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style I fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### Plugin 参加者レスポンスフロー

```mermaid
graph TD
    A(参加者が DM 招待を受信) --> B(自身の DM セッションで返信)
    B --> C(LLM がレスポンスを解析)
    C -->|承諾| D(status = accepted)
    C -->|辞退| E(status = declined)
    C -->|時間帯指定| F(status = proposed_alt + windows)
    C -->|委任| G(辞退 + 委任先を解決 + 新しい招待を送信)
    C -->|ノイズ| H(確認を求める、ツールを呼び出さない)

    D --> MERGE(マージロジック - 追加または置換モード)
    E --> MERGE
    F --> MERGE
    G --> MERGE

    MERGE --> CHECK(pendingCount を確認)
    CHECK -->|他にまだ未応答あり| WAIT(追加レスポンスを待機)
    CHECK -->|全員応答済み| DEBOUNCE(scheduleFinalize - 30秒デバウンス)
    DEBOUNCE -->|30秒以内に新しいレスポンス| RESET(clearTimeout, 30秒を再スタート)
    RESET --> DEBOUNCE
    DEBOUNCE -->|30秒経過| FINAL(finaliseMeeting)

    style MERGE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style DEBOUNCE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style FINAL fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

### Plugin ファイナライズステートマシン

```mermaid
stateDiagram-v2
    [*] --> Collecting: find_and_book_meeting が PendingMeeting を作成

    Collecting --> FastPath: 全参加者が承諾
    Collecting --> Scoring: 一部が代替案を提示
    Collecting --> Failed: 全員が辞退
    Collecting --> Expired: 12時間タイムアウト (ticker)

    FastPath --> Committed: commitMeeting がカレンダーイベントを作成

    Scoring --> Confirming: 発起者が confirm_meeting_slot を呼び出し
    note right of Scoring: scoreSlots が参加者カバレッジでスロットをランク付け

    Confirming --> Committed: 参加者が選択されたスロットを確認
    Confirming --> Failed: スロットが拒否された

    Committed --> [*]: 発起者にイベントリンクを DM
    Failed --> [*]: 発起者に失敗理由を DM
    Expired --> [*]: 発起者に自動キャンセルを DM

    style [*] fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style 収集中 fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style 全承諾 fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style 一部代替案提示 fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style 確認中 fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style committed fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style 全員辞退 fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style 自動キャンセル fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### Plugin バックグラウンドティッカー

```mermaid
graph TD
    TICK(setInterval 60秒ごと) --> GC(gcPending - 古い会議をクリーンアップ)
    GC --> LOOP(各オープン状態の PendingMeeting に対して)
    LOOP --> EXP(確認: now >= expiresAt 12時間?)
    EXP -->|はい| CLOSE(会議をクローズ + 発起者に自動キャンセルを DM)
    EXP -->|いいえ| STATUS(確認: 最終ステータス更新から1時間経過?)
    STATUS -->|はい| DM(発起者にロールコール DM: X/Y 応答済み)
    STATUS -->|いいえ| NEXT(次の会議)

    style CLOSE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style DM fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### Plugin ステート管理

全ステートはインメモリです。ゲートウェイの再起動 = 全ペンディング会議が消失します。

```
pendingMeetings: Map<string, PendingMeeting>     ← 進行中の会議
recentFindAndBook: Map<string, {meetingId, at}>   ← 冪等性 (60秒ウィンドウ)
inflightFindAndBook: Map<string, Promise>         ← 同時実行の重複排除
```

### Plugin ファイル構成

```
plugin_version/
├── shared/                          claw-meeting-shared パッケージ
│   ├── src/
│   │   ├── index.ts                 パッケージエクスポート
│   │   ├── plugin-core.ts           コアロジック: ツール7個、ルーティング、ステートマシン (1131行)
│   │   ├── scheduler.ts             スロット検索、スコアリング、交差計算 (257行)
│   │   ├── load-env.ts              .env ローダー
│   │   └── providers/types.ts       CalendarProvider インターフェース
│   ├── package.json                 claw-meeting-shared
│   └── tsconfig.json
├── unified/                         マルチプラットフォームエントリー (Feishu + Slack)
│   ├── src/
│   │   ├── index.ts                 プラットフォーム設定 + createMeetingPlugin()
│   │   └── providers/
│   │       ├── lark.ts              Feishu バックエンド (1020行)
│   │       └── slack.ts             Slack バックエンド (346行)
│   ├── package.json                 claw-meeting-shared に依存
│   └── tsconfig.json
├── feishu/                          Feishu 専用エントリー
│   └── src/
│       ├── index.ts                 単一プラットフォーム設定
│       └── providers/lark.ts
└── slack/                           Slack 専用エントリー
    └── src/
        ├── index.ts                 単一プラットフォーム設定
        └── providers/slack.ts
```

### Plugin クイックスタート

```bash
cd plugin_version/shared && npm install && npm run build
cd ../unified && npm install && npm run build
openclaw plugins install -l .
openclaw gateway --force
```

---

# Part 2: Skill バージョン (v2.0)

## Skill アーキテクチャ

Skill バージョンは自己完結型の再実装です。モノレポなし、外部パッケージ依存なし。全コードが1つのディレクトリに収まります。クローンして、ビルドして、実行するだけです。

```mermaid
graph TD
    IDX(index.ts - エントリー) --> CORE(plugin-core.ts - ツール7個)
    CORE --> ROUTER(resolveCtx - ctx.messageChannel)
    ROUTER -->|feishu| LP(LarkCalendarProvider - lark.ts)
    ROUTER -->|slack| SP(SlackProvider - slack.ts)
    CORE --> STORE(MeetingStore - meeting-store.ts)
    STORE --> MEM(インメモリ Map)
    STORE --> DISK(pending/*.json ファイル)
    CORE --> SCHED(scheduler.ts)
    IDX --> SKILL(SKILL.md - LLM 指示書)

    style ROUTER fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style STORE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style DISK fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style LP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style SP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

### Plugin からの変更点

| 項目 | Plugin (v1.0) | Skill (v2.0) |
|---|---|---|
| コード構成 | モノレポ (shared + unified + feishu + slack) | 単一ディレクトリ、自己完結型 |
| モジュールシステム | CommonJS | ESM (Node16) |
| 外部依存 | `claw-meeting-shared` パッケージ | なし (全てローカルインポート、`.js` サフィックス付き) |
| ステート層 | インメモリ Map のみ | MeetingStore: Map + ファイル永続化 |
| `__dirname` | CJS ネイティブグローバル | `fileURLToPath(import.meta.url)` |
| エクスポート | `module.exports = plugin` | `export default plugin; export { plugin }` |
| SKILL.md | なし | `openclaw skills add` 用に同梱 |

### Skill プラットフォームルーティング

Plugin と同一。`resolveCtx()` が `ctx.messageChannel` を読み取り、適切なプロバイダーにルーティングします:

```mermaid
graph LR
    MSG(ユーザーメッセージ) --> GW(OpenClaw ゲートウェイ)
    GW --> AGENT(エージェント LLM)
    AGENT -->|tool call| CORE(plugin-core.ts)
    CORE --> CTX(resolveCtx - ctx.messageChannel)
    CTX -->|feishu| LP(LarkCalendarProvider)
    CTX -->|slack| SP(SlackProvider)
    LP --> LAPI(Feishu API)
    SP --> SAPI(Slack API)

    style CTX fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style LP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style SP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

### Skill 会議フロー

Plugin と同じビジネスロジックに永続化を追加:

```mermaid
graph TD
    A(1. ユーザーがメッセージを送信) --> B(2. LLM が find_and_book_meeting を呼び出し)
    B --> C(3. resolveCtx がプラットフォームを検出)
    C --> D(4. プロバイダー経由で参加者名を解決)
    D --> E(5. 重複排除チェック レイヤー1 + レイヤー2)
    E --> F(6. PendingMeeting を作成)
    F --> G(7. store.save - pending/mtg_xxx.json に永続化)
    G --> H(8. プロバイダー経由で DM 招待を送信)
    H --> I(9. LLM に返却)

    I --> J(10. 参加者が DM で返信)
    J --> K(11. record_attendee_response + store.save)
    K --> L(12. 全員応答済み - scheduleFinalize 30秒)
    L --> M(13. finaliseMeeting - ステートマシン)
    M --> N(14. commitMeeting + store.save)
    N --> O(15. カレンダーイベント作成)

    style G fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style K fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style N fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

緑色のノード = `store.save()` 永続化ポイント。ゲートウェイがどの時点で再起動しても、ステートは `pending/*.json` から復旧されます。

### Skill ステート管理

ハイブリッド: 速度のためのインメモリ、耐久性のためのファイル。

```mermaid
graph LR
    subgraph "MeetingStore"
        MAP(インメモリ Map - 高速アクセス)
        FS(pending/mtg_xxx.json - 耐久性)
    end

    WRITE(ステート変更) --> MAP
    WRITE --> FS
    RESTART(ゲートウェイ再起動) --> HYDRATE(store.hydrate)
    HYDRATE -->|pending ディレクトリをスキャン| MAP

    style MAP fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style FS fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style HYDRATE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### Skill ファイナライズステートマシン

Plugin と同一:

```mermaid
stateDiagram-v2
    [*] --> Collecting: find_and_book_meeting

    Collecting --> FastPath: 全員承諾
    Collecting --> Scoring: 一部が proposed_alt
    Collecting --> Failed: 全員辞退
    Collecting --> Expired: 12時間タイムアウト

    FastPath --> Committed: commitMeeting + store.save

    Scoring --> Confirming: confirm_meeting_slot
    note right of Scoring: scoreSlots がカバレッジでランク付け + store.save

    Confirming --> Committed: 全員確認 + store.save

    Committed --> [*]: カレンダーイベント作成
    Failed --> [*]: クローズ + store.save
    Expired --> [*]: 自動キャンセル + store.save

    style [*] fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style 収集中 fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style 全承諾 fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style 一部代替案提示 fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style 確認中 fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style committed fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style 全員辞退 fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style 自動キャンセル fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### Skill バックグラウンドティッカー

Plugin と同一、全ステート変更時に `store.save()` を実行:

```mermaid
graph TD
    TICK(setInterval 60秒ごと) --> GC(gcPending + gcIdempotency)
    GC --> LOOP(各オープン状態の会議に対して)
    LOOP --> EXP(12時間経過?)
    EXP -->|はい| CLOSE(クローズ + DM + store.save)
    EXP -->|いいえ| STATUS(最終更新から1時間経過?)
    STATUS -->|はい| DM(ロールコール DM + store.save)
    STATUS -->|いいえ| NEXT(次へ)

    style CLOSE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style DM fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### Skill ファイル構成

```
skill_version/
├── SKILL.md                         LLM 動作指示書
├── src/
│   ├── index.ts                     エントリーポイント - プラットフォーム設定 (70行)
│   ├── plugin-core.ts               コアロジック: ツール7個、ルーティング、ステートマシン (1176行)
│   ├── meeting-store.ts             MeetingStore: Map + ファイル永続化 (222行)
│   ├── scheduler.ts                 スロット検索、スコアリング、交差計算 (243行)
│   ├── load-env.ts                  .env ローダー (ESM 対応)
│   └── providers/
│       ├── types.ts                 CalendarProvider インターフェース
│       ├── lark.ts                  Feishu バックエンド (770行)
│       └── slack.ts                 Slack バックエンド (345行)
├── pending/                         ランタイムステート (JSON ファイル、gitignore 対象)
├── openclaw.plugin.json             Plugin + Skill マニフェスト
├── package.json                     ESM、@slack/web-api + googleapis + luxon
└── .gitignore                       .env、node_modules、dist、pending を除外
```

### Skill クイックスタート

```bash
cd skill_version
npm install
npm run build
openclaw plugins install -l .
openclaw gateway --force
```

---

# Part 3: バージョン比較 (差分)

## 7つのツール (両バージョン共通)

| # | ツール | 説明 |
|---|------|-------------|
| 1 | `find_and_book_meeting` | ペンディング会議を作成、参加者名を解決、DM 招待を送信 |
| 2 | `list_my_pending_invitations` | 現在の送信者のペンディング招待を一覧表示 |
| 3 | `record_attendee_response` | 承諾 / 辞退 / 代替案提示 / 委任を記録 |
| 4 | `confirm_meeting_slot` | スコアリング結果後に発起者がタイムスロットを選択 |
| 5 | `list_upcoming_meetings` | 今後のカレンダーイベントを一覧表示 |
| 6 | `cancel_meeting` | イベント ID で会議をキャンセル |
| 7 | `debug_list_directory` | テナントディレクトリのユーザーを一覧表示 (診断用) |

## 設定 (両バージョン共通)

```env
# Feishu / Lark
LARK_APP_ID=cli_xxxxx
LARK_APP_SECRET=xxxxx
LARK_CALENDAR_ID=xxxxx@group.calendar.feishu.cn

# Slack
SLACK_BOT_TOKEN=xoxb-xxxxx

# スケジュールデフォルト
DEFAULT_TIMEZONE=Asia/Shanghai
WORK_HOURS=09:00-18:00
LUNCH_BREAK=12:00-13:30
BUFFER_MINUTES=15
```

## 全体比較表

| 項目 | Plugin (v1.0) | Skill (v2.0) |
|---|---|---|
| アーキテクチャ | モノレポ (shared + unified + feishu + slack) | 自己完結型 (単一ディレクトリ) |
| モジュールシステム | CommonJS | ESM (Node16) |
| 依存関係 | `claw-meeting-shared` パッケージ | なし (全てローカル) |
| ポータビリティ | モノレポ + パッケージリンクが必要 | クローンして実行 |
| ツール | 7 | 7 (同一) |
| プラットフォーム | Feishu + Slack | Feishu + Slack (同一) |
| プラットフォームルーティング | `ctx.messageChannel` via `resolveCtx()` | 同一 |
| ステートストレージ | インメモリ Map | インメモリ Map + ファイル永続化 |
| 再起動リカバリ | 全ステート消失 | ステート保持 (`pending/*.json`) |
| ネゴシエーション | 3フェーズ (collecting/scoring/confirming) | 同一 |
| スロットスコアリング | `scoreSlots()` がカバレッジでランク付け | 同一 |
| 委任 | あり ("让XXX替我去") | 同一 |
| 30秒デバウンス | `setTimeout` / `clearTimeout` | 同一 |
| 12時間タイムアウト | `setInterval` ティッカー | 同一 |
| 2層重複排除 | インフライト Promise + SHA256 冪等性 | 同一 |
| 名前解決 | 2ステップ (プロバイダー候補 + LLM 選択) | 同一 |
| インストール | `openclaw plugins install` | `openclaw skills add` |
| SKILL.md | なし | あり |

## 変更点と共通点

```mermaid
graph LR
    subgraph "Skill v2.0 での変更点"
        D1(モノレポ → 自己完結型)
        D2(CommonJS → ESM)
        D3(インメモリのみ → ファイル永続化)
        D4(パッケージ依存 → 全てローカル)
        D5(SKILL.md なし → SKILL.md 同梱)
    end

    subgraph "両バージョン共通"
        S1(ツール7個)
        S2(Feishu + Slack ルーティング)
        S3(3フェーズネゴシエーション)
        S4(30秒デバウンスファイナライズ)
        S5(12時間タイムアウトティッカー)
        S6(2層重複排除)
        S7(scoreSlots ランキング)
        S8(委任サポート)
        S9(2ステップ名前解決)
    end

    style D1 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style D2 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style D3 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style D4 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style D5 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style S1 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style S2 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style S3 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style S4 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style S5 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style S6 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style S7 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style S8 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style S9 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

---

## ライセンス

Private - All rights reserved.
