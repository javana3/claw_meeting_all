# ClawMeeting - 多平台會議排程器

![Version](https://img.shields.io/badge/version-2.0-blue)
![Platform](https://img.shields.io/badge/platform-Feishu%20%7C%20Slack-green)
![License](https://img.shields.io/badge/license-Private-red)
![Tools](https://img.shields.io/badge/tools-7-orange)
![Status](https://img.shields.io/badge/status-production-brightgreen)

[English](./README.md) | [简体中文](./README.zh-CN.md) | **繁體中文** | [日本語](./README.ja.md) | [한국어](./README.ko.md)

---

## 概覽

ClawMeeting 是基於 OpenClaw 的 AI 驅動會議排程系統。它透過三階段協商協議在飛書和 Slack 之間協調多參與者會議，具備智慧時段評分、自動委派和防抖控制的最終確認功能。

提供兩個生產版本：
- **外掛版 (v1.0)** — 使用 CommonJS 的 Monorepo 架構，依賴 `claw-meeting-shared` 套件。需要 Monorepo 結構才能執行。
- **技能版 (v2.0)** — ESM 自包含版本。複製即可執行。檔案持久化儲存。支援 `openclaw skills add` 安裝。

---

## 系統架構

```mermaid
graph TD
    A(使用者訊息) --> B(OpenClaw 閘道)
    B --> C(ctx.messageChannel)
    C -->|feishu| D(飛書服務商)
    C -->|slack| E(Slack 服務商)
    D --> F(日曆 API)
    E --> F
    F --> G(排程器 - 時段查詢與評分)
    G --> H(狀態機 - 三階段協商)
    H --> I(會議已確認)
```

---

## 外掛版 (v1.0)

原始生產實作版本。採用 Monorepo 結構，以 `claw-meeting-shared` 作為共用 npm 套件，包含核心排程邏輯、狀態機和工具定義。每個平台有獨立的進入點，另有 `unified/` 進入點可同時路由兩個平台。

**主要特性：**
- Monorepo 架構：`shared/`（核心）+ `unified/`（多平台）+ `feishu/` + `slack/`（單平台）
- 依賴 `claw-meeting-shared` npm 套件（即 `shared/` 目錄）
- 7 個工具，透過 `ctx.messageChannel` 實現飛書 + Slack 雙平台路由
- 僅記憶體狀態 — 閘道重啟後遺失
- CommonJS 模組系統

### 外掛版結構

```mermaid
graph LR
    subgraph "Monorepo"
        SHARED(shared / claw-meeting-shared)
        UNI(unified / index.ts)
        FEI(feishu / index.ts)
        SLK(slack / index.ts)
    end

    UNI -->|匯入| SHARED
    FEI -->|匯入| SHARED
    SLK -->|匯入| SHARED

    SHARED --> CORE(plugin-core.ts - 7 個工具)
    CORE --> ROUTER(ctx.messageChannel)
    ROUTER -->|feishu| LP(飛書服務商)
    ROUTER -->|slack| SP(Slack 服務商)
    CORE --> MEM(記憶體 Map)
    CORE --> SCH(排程器)
```

---

## 技能版 (v2.0)

使用 ESM 模組的自包含重新實作版本。無外部套件依賴 — 所有程式碼位於單一目錄中。狀態持久化至 `pending/*.json` 檔案，閘道重啟後仍可恢復。包含 `SKILL.md` 以支援 `openclaw skills add` 的使用者友好安裝方式。

**主要特性：**
- 自包含：複製、`npm install`、`npm run build`，即可完成
- 無 Monorepo，無 `claw-meeting-shared` 依賴
- 7 個工具，透過 `ctx.messageChannel` 實現飛書 + Slack 雙平台路由
- 檔案持久化狀態（`pending/` 中的 JSON）— 重啟後保留
- ESM 模組系統（Node16）
- `SKILL.md` 提供 LLM 行為指引

### 技能版結構

```mermaid
graph LR
    IDX(index.ts) --> CORE(plugin-core.ts - 7 個工具)
    CORE --> ROUTER(ctx.messageChannel)
    ROUTER -->|feishu| LP(飛書服務商)
    ROUTER -->|slack| SP(Slack 服務商)
    CORE --> STORE(MeetingStore)
    STORE --> MEM(記憶體 Map)
    STORE --> DISK(pending/*.json)
    CORE --> SCH(排程器)
```

---

## 會議生命週期

```mermaid
stateDiagram-v2
    [*] --> 收集中: find_and_book_meeting
    note right of 收集中: 私訊每位參與者詢問可用時段

    收集中 --> 快速路徑: 全部接受
    收集中 --> 評分中: 部分提出替代方案
    收集中 --> 已取消: 全部拒絕
    收集中 --> 已逾期: 12 小時逾時

    快速路徑 --> 已提交: commitMeeting

    評分中 --> 確認中: confirm_meeting_slot
    note right of 評分中: scoreSlots 依參與者覆蓋率排序

    確認中 --> 已提交: 全部確認
    確認中 --> 已取消: 已拒絕

    已提交 --> [*]: 日曆事件已建立
    已取消 --> [*]: 會議已關閉
    已逾期 --> [*]: 自動取消
```

---

## 參與者回覆流程

```mermaid
graph TD
    A(參與者收到私訊邀請) --> B(在私訊中回覆)
    B --> C(LLM 解析回覆)
    C -->|接受| D(狀態 = 已接受)
    C -->|拒絕| E(狀態 = 已拒絕)
    C -->|時間範圍| F(狀態 = 提出替代)
    C -->|委派| G(標記拒絕 + 新增代理人)
    C -->|雜訊| H(要求澄清)

    D --> I(全部已回覆?)
    E --> I
    F --> I
    G --> I

    I -->|否| J(等待其他人)
    I -->|是| K(30 秒防抖)
    K --> L(finaliseMeeting)
```

---

## 背景程序

```mermaid
graph TD
    A(定時器 - 每 60 秒) --> B(檢查每個進行中的會議)
    B --> C(now >= expiresAt?)
    C -->|是 已過 12 小時| D(關閉 + 私訊發起者)
    C -->|否| E(需要狀態更新?)
    E -->|是 距上次已過 1 小時| F(私訊點名報告給發起者)
    E -->|否| G(跳過)
```

---

## 工具列表

| # | 工具 | 描述 |
|---|------|------|
| 1 | `find_and_book_meeting` | 建立待處理會議、解析參與者名稱、發送私訊邀請 |
| 2 | `list_my_pending_invitations` | 列出目前發送者的待處理邀請 |
| 3 | `record_attendee_response` | 記錄接受 / 拒絕 / 提出替代方案 / 委派 |
| 4 | `confirm_meeting_slot` | 發起者在評分結果後選擇時段 |
| 5 | `list_upcoming_meetings` | 列出即將到來的日曆事件 |
| 6 | `cancel_meeting` | 透過事件 ID 取消會議 |
| 7 | `debug_list_directory` | 列出租戶目錄使用者（診斷用） |

---

## 檔案結構

```
plugin_version/                      Monorepo（需要 claw-meeting-shared）
├── shared/                          核心邏輯套件
│   └── src/
│       ├── plugin-core.ts           7 個工具、路由、狀態機（1131 行）
│       ├── scheduler.ts             時段查詢 + 評分
│       ├── load-env.ts              .env 載入器
│       └── providers/types.ts       CalendarProvider 介面
├── unified/                         多平台進入點（飛書 + Slack）
│   └── src/
│       ├── index.ts                 平台設定
│       └── providers/
│           ├── lark.ts              飛書後端
│           └── slack.ts             Slack 後端
├── feishu/                          僅飛書進入點
│   └── src/
│       ├── index.ts                 單平台設定
│       └── providers/lark.ts        飛書後端
└── slack/                           僅 Slack 進入點
    └── src/
        ├── index.ts                 單平台設定
        └── providers/slack.ts       Slack 後端

skill_version/                       自包含（複製即可執行）
├── SKILL.md                         LLM 指引
├── src/
│   ├── index.ts                     進入點（平台設定）
│   ├── plugin-core.ts               7 個工具、路由、狀態機（1176 行）
│   ├── meeting-store.ts             持久化狀態層（222 行）
│   ├── scheduler.ts                 時段查詢 + 評分
│   ├── load-env.ts                  .env 載入器（ESM）
│   └── providers/
│       ├── types.ts                 CalendarProvider 介面
│       ├── lark.ts                  飛書後端
│       └── slack.ts                 Slack 後端
└── pending/                         執行時會議狀態（JSON 檔案）
```

---

## 快速開始

### 外掛版 (v1.0)

```bash
cd plugin_version/shared && npm install && npm run build
cd ../unified && npm install && npm run build
openclaw plugins install -l .
openclaw gateway --force
```

### 技能版 (v2.0)

```bash
cd skill_version
npm install
npm run build
openclaw plugins install -l .
openclaw gateway --force
```

---

## 設定

兩個版本都需要在 `.env` 中提供平台憑證：

```env
# 飛書 / Lark
LARK_APP_ID=cli_xxxxx
LARK_APP_SECRET=xxxxx
LARK_CALENDAR_ID=xxxxx@group.calendar.feishu.cn

# Slack
SLACK_BOT_TOKEN=xoxb-xxxxx

# 排程預設值
DEFAULT_TIMEZONE=Asia/Shanghai
WORK_HOURS=09:00-18:00
LUNCH_BREAK=12:00-13:30
BUFFER_MINUTES=15
```

---

## 版本對比

| 面向 | 外掛版 (v1.0) | 技能版 (v2.0) |
|---|---|---|
| 架構 | Monorepo（shared + unified + feishu + slack） | 自包含（單一目錄） |
| 模組系統 | CommonJS | ESM（Node16） |
| 依賴 | `claw-meeting-shared` 套件 | 無（全部本地） |
| 可攜性 | 需要 Monorepo 結構 | 複製即可執行 |
| 工具數量 | 7 | 7 |
| 平台支援 | 飛書 + Slack | 飛書 + Slack |
| 平台路由 | `ctx.messageChannel` | `ctx.messageChannel` |
| 狀態儲存 | 記憶體 Map | 記憶體 + 檔案持久化 |
| 重啟恢復 | 狀態遺失 | 狀態保留（pending/*.json） |
| 協商模式 | 三階段（收集/評分/確認） | 三階段（相同） |
| 評分功能 | 有（scoreSlots） | 有（相同） |
| 委派功能 | 有 | 有 |
| 安裝方式 | `openclaw plugins install` | `openclaw skills add` |
| SKILL.md | 無 | 有 |

```mermaid
graph LR
    subgraph "差異"
        D1(Monorepo → 自包含)
        D2(CJS → ESM)
        D3(記憶體 → 檔案持久化)
        D4(套件依賴 → 無依賴)
    end

    subgraph "相同"
        S1(7 個工具)
        S2(飛書 + Slack 路由)
        S3(三階段協商)
        S4(30 秒防抖)
        S5(12 小時逾時)
        S6(雙層去重)
        S7(scoreSlots 排序)
        S8(委派支援)
    end

    style D1 fill:#22c55e,color:#fff
    style D2 fill:#22c55e,color:#fff
    style D3 fill:#22c55e,color:#fff
    style D4 fill:#22c55e,color:#fff
    style S1 fill:#6366f1,color:#fff
    style S2 fill:#6366f1,color:#fff
    style S3 fill:#6366f1,color:#fff
    style S4 fill:#6366f1,color:#fff
    style S5 fill:#6366f1,color:#fff
    style S6 fill:#6366f1,color:#fff
    style S7 fill:#6366f1,color:#fff
    style S8 fill:#6366f1,color:#fff
```

---

## 授權條款

私有 - 保留所有權利。
