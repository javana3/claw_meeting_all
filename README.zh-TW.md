# ClawMeeting - 多平台會議排程系統

![Version](https://img.shields.io/badge/version-2.0-blue)
![Platform](https://img.shields.io/badge/platform-Feishu%20%7C%20Slack-green)
![License](https://img.shields.io/badge/license-Private-red)
![Tools](https://img.shields.io/badge/tools-7-orange)
![Status](https://img.shields.io/badge/status-production-brightgreen)

[English](./README.md) | [简体中文](./README.zh-CN.md) | **繁體中文** | [日本語](./README.ja.md) | [한국어](./README.ko.md)

---

## 概覽

ClawMeeting 是一個為 OpenClaw 打造的 AI 驅動會議排程系統。它透過自然語言在飛書和 Slack 之間協調多參與者會議，具備智慧時段評分、三階段協商、自動委派及防抖控制的最終確認機制。

本倉庫包含兩種實作：
- **外掛版（v1.0）** — 原始生產版本。CommonJS 單體倉庫，搭配 `claw-meeting-shared` 套件。
- **技能版（v2.0）** — 獨立的 ESM 重新實作，支援檔案持久化儲存。

兩個版本均支援**飛書 + Slack 雙平台路由**、**7 個工具**及**相同的業務邏輯**。

---

# 第一部分：外掛版（v1.0）

## 外掛架構

外掛採用單體倉庫結構。核心排程邏輯位於 `shared/` 套件（`claw-meeting-shared`），而平台專屬的提供者和進入點位於獨立目錄中。

```mermaid
graph TD
    subgraph "單體倉庫結構"
        SHARED(shared / claw-meeting-shared)
        UNI(unified / index.ts)
        FEI(feishu / index.ts)
        SLK(slack / index.ts)
    end

    UNI -->|匯入| SHARED
    FEI -->|匯入| SHARED
    SLK -->|匯入| SHARED

    SHARED --> CORE(plugin-core.ts)
    CORE --> TOOLS(7 個已註冊工具)
    CORE --> SCHED(scheduler.ts)
    CORE --> STATE(記憶體內狀態映射)

    style SHARED fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style CORE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style STATE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### 外掛進入點

| 進入點 | 路徑 | 用途 |
|---|---|---|
| **unified** | `unified/src/index.ts` | 多平台（飛書 + Slack）。生產環境預設。 |
| **feishu** | `feishu/src/index.ts` | 僅飛書部署 |
| **slack** | `slack/src/index.ts` | 僅 Slack 部署 |

三者皆從 `claw-meeting-shared` 匯入，並以平台專屬設定呼叫 `createMeetingPlugin()`。

### 外掛平台路由

```mermaid
graph LR
    MSG(使用者訊息) --> GW(OpenClaw 閘道器)
    GW --> AGENT(Agent LLM)
    AGENT -->|工具呼叫| CORE(plugin-core.ts)
    CORE --> CTX(resolveCtx - ctx.messageChannel)
    CTX -->|feishu| LP(LarkCalendarProvider)
    CTX -->|slack| SP(SlackProvider)
    LP --> LAPI(飛書日曆 API)
    LP --> LDIR(飛書通訊錄 API)
    LP --> LDM(飛書即時通訊 API)
    SP --> SDIR(Slack users.list API)
    SP --> SDM(Slack chat.postMessage)

    style CTX fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style LP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style SP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

### 外掛會議流程

外掛中逐步的資料流：

```mermaid
graph TD
    A(1. 使用者在飛書/Slack 中發送訊息) --> B(2. 閘道器將訊息分派給 Agent LLM)
    B --> C(3. LLM 識別意圖，呼叫 find_and_book_meeting)
    C --> D(4. resolveCtx 從 ctx.messageChannel 偵測平台)
    D --> E(5. normalizeAttendees 依平台規則驗證 ID)
    E --> F(6. provider.resolveUsers 從目錄解析姓名)
    F --> G(7. 進行中去重 第一層 - Promise 共享)
    G --> H(8. 解析後冪等性 第二層 - SHA256 60秒視窗)
    H --> I(9. 在記憶體 Map 中建立 PendingMeeting)
    I --> J(10. provider.sendTextDM 向每位參與者發送邀請)
    J --> K(11. 將 meetingId 回傳給 LLM，LLM 回覆使用者)

    style D fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style G fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style H fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style I fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### 外掛參與者回應流程

```mermaid
graph TD
    A(參與者收到私訊邀請) --> B(在自己的私訊對話中回覆)
    B --> C(LLM 解析回應)
    C -->|接受| D(status = accepted)
    C -->|拒絕| E(status = declined)
    C -->|時間範圍| F(status = proposed_alt + windows)
    C -->|委派| G(拒絕 + 解析被委派者 + 發送新邀請)
    C -->|無關訊息| H(要求澄清，不呼叫工具)

    D --> MERGE(合併邏輯 - 附加或替換模式)
    E --> MERGE
    F --> MERGE
    G --> MERGE

    MERGE --> CHECK(檢查 pendingCount)
    CHECK -->|其他人仍待回應| WAIT(等待更多回應)
    CHECK -->|所有人已回應| DEBOUNCE(scheduleFinalize - 30秒防抖)
    DEBOUNCE -->|30秒內有新回應| RESET(clearTimeout，重啟30秒)
    RESET --> DEBOUNCE
    DEBOUNCE -->|30秒已過| FINAL(finaliseMeeting)

    style MERGE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style DEBOUNCE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style FINAL fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

### 外掛最終確認狀態機

```mermaid
stateDiagram-v2
    [*] --> 收集中: find_and_book_meeting 建立 PendingMeeting

    收集中 --> 快速路徑: 所有參與者已接受
    收集中 --> 評分中: 部分提出替代方案
    收集中 --> 失敗: 所有人拒絕
    收集中 --> 已過期: 12小時逾時（定時器）

    快速路徑 --> 已提交: commitMeeting 建立日曆事件

    評分中 --> 確認中: 發起人呼叫 confirm_meeting_slot
    note right of 評分中: scoreSlots 依參與者覆蓋率排名時段

    確認中 --> 已提交: 參與者確認所選時段
    確認中 --> 失敗: 時段被拒絕

    已提交 --> [*]: 私訊發起人附帶事件連結
    失敗 --> [*]: 私訊發起人附帶失敗原因
    已過期 --> [*]: 私訊發起人已自動取消

    style [*] fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style Collecting fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style FastPath fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Scoring fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Confirming fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Committed fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Failed fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Expired fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### 外掛背景定時器

```mermaid
graph TD
    TICK(setInterval 每60秒) --> GC(gcPending - 清理舊會議)
    GC --> LOOP(遍歷每個未完成的 PendingMeeting)
    LOOP --> EXP(檢查: now >= expiresAt 12小時?)
    EXP -->|是| CLOSE(關閉會議 + 私訊發起人已自動取消)
    EXP -->|否| STATUS(檢查: 距上次狀態更新已超過1小時?)
    STATUS -->|是| DM(私訊發起人點名: X/Y 已回應)
    STATUS -->|否| NEXT(下一個會議)

    style CLOSE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style DM fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### 外掛狀態管理

所有狀態皆在記憶體中。閘道器重啟 = 所有待處理會議遺失。

```
pendingMeetings: Map<string, PendingMeeting>     ← 進行中的會議
recentFindAndBook: Map<string, {meetingId, at}>   ← 冪等性（60秒視窗）
inflightFindAndBook: Map<string, Promise>         ← 並行去重
```

### 外掛檔案結構

```
plugin_version/
├── shared/                          claw-meeting-shared 套件
│   ├── src/
│   │   ├── index.ts                 套件匯出
│   │   ├── plugin-core.ts           核心邏輯：7 個工具、路由、狀態機（1131 行）
│   │   ├── scheduler.ts             時段查詢、評分、交集（257 行）
│   │   ├── load-env.ts              .env 載入器
│   │   └── providers/types.ts       CalendarProvider 介面
│   ├── package.json                 claw-meeting-shared
│   └── tsconfig.json
├── unified/                         多平台進入點（飛書 + Slack）
│   ├── src/
│   │   ├── index.ts                 平台設定 + createMeetingPlugin()
│   │   └── providers/
│   │       ├── lark.ts              飛書後端（1020 行）
│   │       └── slack.ts             Slack 後端（346 行）
│   ├── package.json                 依賴 claw-meeting-shared
│   └── tsconfig.json
├── feishu/                          僅飛書進入點
│   └── src/
│       ├── index.ts                 單平台設定
│       └── providers/lark.ts
└── slack/                           僅 Slack 進入點
    └── src/
        ├── index.ts                 單平台設定
        └── providers/slack.ts
```

### 外掛快速開始

```bash
cd plugin_version/shared && npm install && npm run build
cd ../unified && npm install && npm run build
openclaw plugins install -l .
openclaw gateway --force
```

---

# 第二部分：技能版（v2.0）

## 技能架構

技能版是獨立的重新實作。無單體倉庫，無外部套件依賴。所有程式碼在一個目錄中。複製、建置、執行。

```mermaid
graph TD
    IDX(index.ts - 進入點) --> CORE(plugin-core.ts - 7 個工具)
    CORE --> ROUTER(resolveCtx - ctx.messageChannel)
    ROUTER -->|feishu| LP(LarkCalendarProvider - lark.ts)
    ROUTER -->|slack| SP(SlackProvider - slack.ts)
    CORE --> STORE(MeetingStore - meeting-store.ts)
    STORE --> MEM(記憶體內 Map)
    STORE --> DISK(pending/*.json 檔案)
    CORE --> SCHED(scheduler.ts)
    IDX --> SKILL(SKILL.md - LLM 指令)

    style ROUTER fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style STORE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style DISK fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style LP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style SP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

### 與外掛版的差異

| 面向 | 外掛版（v1.0） | 技能版（v2.0） |
|---|---|---|
| 程式碼結構 | 單體倉庫（shared + unified + feishu + slack） | 單一目錄，獨立運作 |
| 模組系統 | CommonJS | ESM（Node16） |
| 外部依賴 | `claw-meeting-shared` 套件 | 無（所有本地匯入帶 `.js` 後綴） |
| 狀態層 | 僅記憶體內 Map | MeetingStore：Map + 檔案持久化 |
| `__dirname` | 原生 CJS 全域變數 | `fileURLToPath(import.meta.url)` |
| 匯出方式 | `module.exports = plugin` | `export default plugin; export { plugin }` |
| SKILL.md | 無 | 包含，用於 `openclaw skills add` |

### 技能版平台路由

與外掛版相同。`resolveCtx()` 讀取 `ctx.messageChannel` 並路由至正確的提供者：

```mermaid
graph LR
    MSG(使用者訊息) --> GW(OpenClaw 閘道器)
    GW --> AGENT(Agent LLM)
    AGENT -->|工具呼叫| CORE(plugin-core.ts)
    CORE --> CTX(resolveCtx - ctx.messageChannel)
    CTX -->|feishu| LP(LarkCalendarProvider)
    CTX -->|slack| SP(SlackProvider)
    LP --> LAPI(飛書 API)
    SP --> SAPI(Slack API)

    style CTX fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style LP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style SP fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

### 技能版會議流程

與外掛版相同的業務邏輯，新增持久化：

```mermaid
graph TD
    A(1. 使用者發送訊息) --> B(2. LLM 呼叫 find_and_book_meeting)
    B --> C(3. resolveCtx 偵測平台)
    C --> D(4. 透過提供者解析參與者姓名)
    D --> E(5. 去重檢查 第一層 + 第二層)
    E --> F(6. 建立 PendingMeeting)
    F --> G(7. store.save - 持久化至 pending/mtg_xxx.json)
    G --> H(8. 透過提供者發送私訊邀請)
    H --> I(9. 回傳給 LLM)

    I --> J(10. 參與者在私訊中回覆)
    J --> K(11. record_attendee_response + store.save)
    K --> L(12. 所有人已回應 - scheduleFinalize 30秒)
    L --> M(13. finaliseMeeting - 狀態機)
    M --> N(14. commitMeeting + store.save)
    N --> O(15. 日曆事件已建立)

    style G fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style K fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style N fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
```

綠色節點 = `store.save()` 持久化點。若閘道器在任何時刻重啟，狀態將從 `pending/*.json` 恢復。

### 技能版狀態管理

混合式：記憶體保障速度，檔案保障持久性。

```mermaid
graph LR
    subgraph "MeetingStore"
        MAP(記憶體內 Map - 快速存取)
        FS(pending/mtg_xxx.json - 持久性)
    end

    WRITE(狀態變更) --> MAP
    WRITE --> FS
    RESTART(閘道器重啟) --> HYDRATE(store.hydrate)
    HYDRATE -->|掃描 pending 目錄| MAP

    style MAP fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style FS fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style HYDRATE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### 技能版最終確認狀態機

與外掛版相同：

```mermaid
stateDiagram-v2
    [*] --> 收集中: find_and_book_meeting

    收集中 --> 快速路徑: 所有人已接受
    收集中 --> 評分中: 部分提出 proposed_alt
    收集中 --> 失敗: 所有人拒絕
    收集中 --> 已過期: 12小時逾時

    快速路徑 --> 已提交: commitMeeting + store.save

    評分中 --> 確認中: confirm_meeting_slot
    note right of 評分中: scoreSlots 依覆蓋率排名 + store.save

    確認中 --> 已提交: 所有人確認 + store.save

    已提交 --> [*]: 日曆事件已建立
    失敗 --> [*]: 已關閉 + store.save
    已過期 --> [*]: 已自動取消 + store.save

    style [*] fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style Collecting fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style FastPath fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Scoring fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Confirming fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Committed fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Failed fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Expired fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### 技能版背景定時器

與外掛版相同，每次狀態變更皆執行 `store.save()`：

```mermaid
graph TD
    TICK(setInterval 每60秒) --> GC(gcPending + gcIdempotency)
    GC --> LOOP(遍歷每個未完成會議)
    LOOP --> EXP(12小時已過期?)
    EXP -->|是| CLOSE(關閉 + 私訊 + store.save)
    EXP -->|否| STATUS(距上次更新已超過1小時?)
    STATUS -->|是| DM(私訊點名 + store.save)
    STATUS -->|否| NEXT(下一個)

    style CLOSE fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style DM fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
```

### 技能版檔案結構

```
skill_version/
├── SKILL.md                         LLM 行為指令
├── src/
│   ├── index.ts                     進入點 - 平台設定（70 行）
│   ├── plugin-core.ts               核心邏輯：7 個工具、路由、狀態機（1176 行）
│   ├── meeting-store.ts             MeetingStore：Map + 檔案持久化（222 行）
│   ├── scheduler.ts                 時段查詢、評分、交集（243 行）
│   ├── load-env.ts                  .env 載入器（ESM 相容）
│   └── providers/
│       ├── types.ts                 CalendarProvider 介面
│       ├── lark.ts                  飛書後端（770 行）
│       └── slack.ts                 Slack 後端（345 行）
├── pending/                         執行時狀態（JSON 檔案，已加入 gitignore）
├── openclaw.plugin.json             外掛 + 技能清單
├── package.json                     ESM，@slack/web-api + googleapis + luxon
└── .gitignore                       排除 .env、node_modules、dist、pending
```

### 技能版快速開始

```bash
cd skill_version
npm install
npm run build
openclaw plugins install -l .
openclaw gateway --force
```

---

# 第三部分：版本比較（差異）

## 7 個工具（兩個版本共用）

| # | 工具 | 說明 |
|---|------|-------------|
| 1 | `find_and_book_meeting` | 建立待處理會議、解析參與者姓名、發送私訊邀請 |
| 2 | `list_my_pending_invitations` | 列出當前發送者的待處理邀請 |
| 3 | `record_attendee_response` | 記錄接受 / 拒絕 / 提出替代方案 / 委派 |
| 4 | `confirm_meeting_slot` | 發起人在評分結果後選擇時段 |
| 5 | `list_upcoming_meetings` | 列出即將到來的日曆事件 |
| 6 | `cancel_meeting` | 依事件 ID 取消會議 |
| 7 | `debug_list_directory` | 列出租戶目錄使用者（診斷用） |

## 設定（兩個版本共用）

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

## 完整比較表

| 維度 | 外掛版（v1.0） | 技能版（v2.0） |
|---|---|---|
| 架構 | 單體倉庫（shared + unified + feishu + slack） | 獨立運作（單一目錄） |
| 模組系統 | CommonJS | ESM（Node16） |
| 依賴 | `claw-meeting-shared` 套件 | 無（全部本地） |
| 可移植性 | 需要單體倉庫 + 套件連結 | 複製即可執行 |
| 工具數 | 7 | 7（相同） |
| 平台 | 飛書 + Slack | 飛書 + Slack（相同） |
| 平台路由 | 透過 `resolveCtx()` 的 `ctx.messageChannel` | 相同 |
| 狀態儲存 | 記憶體內 Map | 記憶體內 Map + 檔案持久化 |
| 重啟恢復 | 所有狀態遺失 | 狀態已保留（`pending/*.json`） |
| 協商機制 | 三階段（收集中/評分中/確認中） | 相同 |
| 時段評分 | `scoreSlots()` 依覆蓋率排名 | 相同 |
| 委派 | 是（「讓XXX替我去」） | 相同 |
| 30秒防抖 | `setTimeout` / `clearTimeout` | 相同 |
| 12小時逾時 | `setInterval` 定時器 | 相同 |
| 兩層去重 | 進行中 Promise + SHA256 冪等性 | 相同 |
| 姓名解析 | 兩步驟（提供者候選 + LLM 選取） | 相同 |
| 安裝方式 | `openclaw plugins install` | `openclaw skills add` |
| SKILL.md | 否 | 是 |

## 變更項目與未變更項目

```mermaid
graph LR
    subgraph "技能版 v2.0 中的變更"
        D1(單體倉庫 → 獨立運作)
        D2(CommonJS → ESM)
        D3(僅記憶體 → 檔案持久化)
        D4(套件依賴 → 全部本地)
        D5(無 SKILL.md → 包含 SKILL.md)
    end

    subgraph "兩個版本中相同的部分"
        S1(7 個工具)
        S2(飛書 + Slack 路由)
        S3(三階段協商)
        S4(30秒防抖最終確認)
        S5(12小時逾時定時器)
        S6(兩層去重)
        S7(scoreSlots 排名)
        S8(委派支援)
        S9(兩步驟姓名解析)
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

## 授權條款

私有 - 保留所有權利。
