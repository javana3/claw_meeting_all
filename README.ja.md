# ClawMeeting - マルチプラットフォーム会議スケジューラー

![Version](https://img.shields.io/badge/version-2.0-blue)
![Platform](https://img.shields.io/badge/platform-Feishu%20%7C%20Slack-green)
![License](https://img.shields.io/badge/license-Private-red)
![Tools](https://img.shields.io/badge/tools-7-orange)
![Status](https://img.shields.io/badge/status-production-brightgreen)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | **日本語** | [한국어](./README.ko.md)

---

## 概要

ClawMeeting は、OpenClaw 向けの AI 駆動型会議スケジューリングシステムです。Feishu と Slack をまたいで複数参加者の会議を調整し、インテリジェントなタイムスロットスコアリング、自動委任、デバウンス制御によるファイナライズを備えた 3 フェーズネゴシエーションプロトコルで動作します。

本番環境向けに 2 つのバージョンを提供しています：
- **プラグイン版 (v1.0)** — CommonJS モノレポ構成。`claw-meeting-shared` パッケージに依存。実行にはモノレポ構成が必要です。
- **スキル版 (v2.0)** — ESM 自己完結型。クローンしてすぐ実行可能。ファイルベースの永続化。`openclaw skills add` による簡単インストール。

---

## アーキテクチャ

```mermaid
graph TD
    A(ユーザーメッセージ) --> B(OpenClaw ゲートウェイ)
    B --> C{ctx.messageChannel}
    C -->|feishu| D(Feishu プロバイダー)
    C -->|slack| E(Slack プロバイダー)
    D --> F(カレンダー API)
    E --> F
    F --> G(スケジューラー - スロット検索 & スコアリング)
    G --> H(ステートマシン - 3 フェーズネゴシエーション)
    H --> I(会議確定)
```

---

## プラグイン版 (v1.0)

初期の本番実装です。コアスケジューリングロジック、ステートマシン、ツール定義を含む共有 npm パッケージ `claw-meeting-shared` を持つモノレポ構成を採用しています。各プラットフォームに専用のエントリーポイントがあり、`unified/` エントリーが両プラットフォームをルーティングします。

**主な特徴：**
- モノレポ構成：`shared/`（コア）+ `unified/`（マルチプラットフォーム）+ `feishu/` + `slack/`（単一プラットフォーム）
- `claw-meeting-shared` npm パッケージ（`shared/` ディレクトリ）に依存
- 7 ツール、Feishu + Slack デュアルプラットフォームルーティング（`ctx.messageChannel` 経由）
- インメモリ状態のみ — ゲートウェイ再起動で消失
- CommonJS モジュールシステム

### プラグイン構成

```mermaid
graph LR
    subgraph "モノレポ"
        SHARED(shared / claw-meeting-shared)
        UNI(unified / index.ts)
        FEI(feishu / index.ts)
        SLK(slack / index.ts)
    end

    UNI -->|import| SHARED
    FEI -->|import| SHARED
    SLK -->|import| SHARED

    SHARED --> CORE(plugin-core.ts - 7 ツール)
    CORE --> ROUTER{ctx.messageChannel}
    ROUTER -->|feishu| LP(Lark プロバイダー)
    ROUTER -->|slack| SP(Slack プロバイダー)
    CORE --> MEM[(インメモリ Map)]
    CORE --> SCH(スケジューラー)
```

---

## スキル版 (v2.0)

ESM モジュールを使用した自己完結型の再実装です。外部パッケージ依存なし — すべてのコードが 1 つのディレクトリに収まっています。状態は `pending/*.json` ファイルに永続化され、ゲートウェイの再起動後も保持されます。`openclaw skills add` による簡単インストールのための `SKILL.md` を含みます。

**主な特徴：**
- 自己完結型：クローン、`npm install`、`npm run build` で完了
- モノレポ不要、`claw-meeting-shared` 依存なし
- 7 ツール、Feishu + Slack デュアルプラットフォームルーティング（`ctx.messageChannel` 経由）
- ファイル永続化状態（`pending/` 内の JSON）— 再起動後も保持
- ESM モジュールシステム（Node16）
- LLM 動作指示用の `SKILL.md`

### スキル構成

```mermaid
graph LR
    IDX(index.ts) --> CORE(plugin-core.ts - 7 ツール)
    CORE --> ROUTER{ctx.messageChannel}
    ROUTER -->|feishu| LP(Lark プロバイダー)
    ROUTER -->|slack| SP(Slack プロバイダー)
    CORE --> STORE(MeetingStore)
    STORE --> MEM(インメモリ Map)
    STORE --> DISK(pending/*.json)
    CORE --> SCH(スケジューラー)
```

---

## 会議ライフサイクル

```mermaid
stateDiagram-v2
    [*] --> Collecting: find_and_book_meeting
    note right of Collecting: 各参加者に空き状況を DM で確認

    Collecting --> FastPath: 全員承諾
    Collecting --> Scoring: 代替案の提案あり
    Collecting --> Cancelled: 全員辞退
    Collecting --> Expired: 12 時間タイムアウト

    FastPath --> Committed: commitMeeting

    Scoring --> Confirming: confirm_meeting_slot
    note right of Scoring: scoreSlots が参加者カバレッジでランク付け

    Confirming --> Committed: 全員確認
    Confirming --> Cancelled: 辞退

    Committed --> [*]: カレンダーイベント作成
    Cancelled --> [*]: 会議終了
    Expired --> [*]: 自動キャンセル
```

---

## 参加者の応答フロー

```mermaid
graph TD
    A(参加者が DM 招待を受信) --> B(DM で返信)
    B --> C{LLM が応答を解析}
    C -->|承諾| D(status = accepted)
    C -->|辞退| E(status = declined)
    C -->|希望時間帯| F(status = proposed_alt)
    C -->|委任| G(辞退として記録 + 代理人を追加)
    C -->|ノイズ| H(確認を依頼)

    D --> I{全員回答済み？}
    E --> I
    F --> I
    G --> I

    I -->|いいえ| J(他の参加者を待機)
    I -->|はい| K(30 秒デバウンス)
    K --> L(finaliseMeeting)
```

---

## バックグラウンド処理

```mermaid
graph TD
    A(タイマー - 60 秒ごと) --> B{各オープン会議を確認}
    B --> C{now >= expiresAt？}
    C -->|はい - 12 時間経過| D(クローズ + 発起者に DM)
    C -->|いいえ| E{ステータス更新の時期？}
    E -->|はい - 前回から 1 時間経過| F(発起者にロールコール DM)
    E -->|いいえ| G(スキップ)
```

---

## ツール一覧

| # | ツール | 説明 |
|---|--------|------|
| 1 | `find_and_book_meeting` | 保留中の会議を作成、参加者名を解決、DM 招待を送信 |
| 2 | `list_my_pending_invitations` | 現在の送信者の保留中の招待を一覧表示 |
| 3 | `record_attendee_response` | 承諾 / 辞退 / 代替案の提案 / 委任を記録 |
| 4 | `confirm_meeting_slot` | スコアリング結果に基づき発起者がタイムスロットを選択 |
| 5 | `list_upcoming_meetings` | 今後のカレンダーイベントを一覧表示 |
| 6 | `cancel_meeting` | イベント ID で会議をキャンセル |
| 7 | `debug_list_directory` | テナントディレクトリのユーザーを一覧表示（診断用） |

---

## ファイル構成

```
plugin_version/                      モノレポ（claw-meeting-shared が必要）
├── shared/                          コアロジックパッケージ
│   └── src/
│       ├── plugin-core.ts           7 ツール、ルーティング、ステートマシン（1131 行）
│       ├── scheduler.ts             スロット検索 + スコアリング
│       ├── load-env.ts              .env ローダー
│       └── providers/types.ts       CalendarProvider インターフェース
├── unified/                         マルチプラットフォームエントリー（Feishu + Slack）
│   └── src/
│       ├── index.ts                 プラットフォーム設定
│       └── providers/
│           ├── lark.ts              Feishu バックエンド
│           └── slack.ts             Slack バックエンド
├── feishu/                          Feishu 専用エントリー
│   └── src/
│       ├── index.ts                 単一プラットフォーム設定
│       └── providers/lark.ts        Feishu バックエンド
└── slack/                           Slack 専用エントリー
    └── src/
        ├── index.ts                 単一プラットフォーム設定
        └── providers/slack.ts       Slack バックエンド

skill_version/                       自己完結型（クローンして実行）
├── SKILL.md                         LLM 指示書
├── src/
│   ├── index.ts                     エントリーポイント（プラットフォーム設定）
│   ├── plugin-core.ts               7 ツール、ルーティング、ステートマシン（1176 行）
│   ├── meeting-store.ts             永続化状態レイヤー（222 行）
│   ├── scheduler.ts                 スロット検索 + スコアリング
│   ├── load-env.ts                  .env ローダー（ESM）
│   └── providers/
│       ├── types.ts                 CalendarProvider インターフェース
│       ├── lark.ts                  Feishu バックエンド
│       └── slack.ts                 Slack バックエンド
└── pending/                         ランタイム会議状態（JSON ファイル）
```

---

## クイックスタート

### プラグイン版 (v1.0)

```bash
cd plugin_version/shared && npm install && npm run build
cd ../unified && npm install && npm run build
openclaw plugins install -l .
openclaw gateway --force
```

### スキル版 (v2.0)

```bash
cd skill_version
npm install
npm run build
openclaw plugins install -l .
openclaw gateway --force
```

---

## 設定

両バージョンとも `.env` にプラットフォーム認証情報が必要です：

```env
# Feishu / Lark
LARK_APP_ID=cli_xxxxx
LARK_APP_SECRET=xxxxx
LARK_CALENDAR_ID=xxxxx@group.calendar.feishu.cn

# Slack
SLACK_BOT_TOKEN=xoxb-xxxxx

# スケジュールのデフォルト設定
DEFAULT_TIMEZONE=Asia/Shanghai
WORK_HOURS=09:00-18:00
LUNCH_BREAK=12:00-13:30
BUFFER_MINUTES=15
```

---

## バージョン比較

| 項目 | プラグイン版 (v1.0) | スキル版 (v2.0) |
|------|---------------------|-----------------|
| アーキテクチャ | モノレポ（shared + unified + feishu + slack） | 自己完結型（単一ディレクトリ） |
| モジュールシステム | CommonJS | ESM（Node16） |
| 依存関係 | `claw-meeting-shared` パッケージ | なし（すべてローカル） |
| 可搬性 | モノレポ構成が必要 | クローンして実行 |
| ツール数 | 7 | 7 |
| プラットフォーム | Feishu + Slack | Feishu + Slack |
| プラットフォームルーティング | `ctx.messageChannel` | `ctx.messageChannel` |
| 状態保存 | インメモリ Map | インメモリ + ファイル永続化 |
| 再起動時の復旧 | 状態消失 | 状態保持（pending/*.json） |
| ネゴシエーション | 3 フェーズ（collecting/scoring/confirming） | 3 フェーズ（同一） |
| スコアリング | あり（scoreSlots） | あり（同一） |
| 委任 | あり | あり |
| インストール | `openclaw plugins install` | `openclaw skills add` |
| SKILL.md | なし | あり |

```mermaid
graph LR
    subgraph "変更点"
        D1(モノレポ → 自己完結型)
        D2(CJS → ESM)
        D3(インメモリ → ファイル永続化)
        D4(パッケージ依存 → 依存なし)
    end

    subgraph "共通"
        S1(7 ツール)
        S2(Feishu + Slack ルーティング)
        S3(3 フェーズネゴシエーション)
        S4(30 秒デバウンス)
        S5(12 時間タイムアウト)
        S6(2 層重複排除)
        S7(scoreSlots ランキング)
        S8(委任サポート)
    end

    style D1 fill:#22c55e,color:#fff
    style D2 fill:#22c55e,color:#fff
    style D3 fill:#22c55e,color:#fff
    style D4 fill:#22c55e,color:#fff
    style S1 fill:#64748b,color:#fff
    style S2 fill:#64748b,color:#fff
    style S3 fill:#64748b,color:#fff
    style S4 fill:#64748b,color:#fff
    style S5 fill:#64748b,color:#fff
    style S6 fill:#64748b,color:#fff
    style S7 fill:#64748b,color:#fff
    style S8 fill:#64748b,color:#fff
```

---

## ライセンス

Private - All rights reserved.
