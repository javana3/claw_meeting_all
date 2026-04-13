# ClawMeeting - 多平台会议调度系统

![Version](https://img.shields.io/badge/version-2.0-blue)
![Platform](https://img.shields.io/badge/platform-Feishu%20%7C%20Slack-green)
![License](https://img.shields.io/badge/license-Private-red)
![Tools](https://img.shields.io/badge/tools-7-orange)
![Status](https://img.shields.io/badge/status-production-brightgreen)

[English](./README.md) | **简体中文** | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md)

---

## 概述

ClawMeeting 是一个基于 AI 的 OpenClaw 会议调度系统。它通过自然语言在飞书和 Slack 之间协调多参与者会议，具备智能时间段评分、三阶段协商、自动委派和防抖控制的最终确认功能。

本仓库包含两个实现版本：
- **插件版 (v1.0)** — 最初的生产版本。CommonJS 单仓库结构，包含 `claw-meeting-shared` 包。
- **技能版 (v2.0)** — 自包含的 ESM 重新实现，支持文件持久化。

两个版本均支持**飞书 + Slack 双平台路由**、**7 个工具**以及**相同的业务逻辑**。

---

# 第一部分：插件版 (v1.0)

## 插件架构

插件采用单仓库结构。核心调度逻辑位于 `shared/` 包（`claw-meeting-shared`）中，而平台特定的提供者和入口点位于独立目录中。

```mermaid
graph TD
    subgraph "单仓库结构"
        SHARED(shared / claw-meeting-shared)
        UNI(unified / index.ts)
        FEI(feishu / index.ts)
        SLK(slack / index.ts)
    end

    UNI -->|导入| SHARED
    FEI -->|导入| SHARED
    SLK -->|导入| SHARED

    SHARED --> CORE(plugin-core.ts)
    CORE --> TOOLS(7 个已注册工具)
    CORE --> SCHED(scheduler.ts)
    CORE --> STATE(内存状态 Map)

    style SHARED fill:#3b82f6,color:#fff
    style CORE fill:#0ea5e9,color:#fff
    style STATE fill:#ef4444,color:#fff
```

### 插件入口点

| 入口 | 路径 | 用途 |
|---|---|---|
| **unified** | `unified/src/index.ts` | 多平台（飞书 + Slack）。生产环境默认入口。 |
| **feishu** | `feishu/src/index.ts` | 仅飞书部署 |
| **slack** | `slack/src/index.ts` | 仅 Slack 部署 |

三个入口均从 `claw-meeting-shared` 导入，并使用平台特定配置调用 `createMeetingPlugin()`。

### 插件平台路由

```mermaid
graph LR
    MSG(用户消息) --> GW(OpenClaw 网关)
    GW --> AGENT(Agent LLM)
    AGENT -->|工具调用| CORE(plugin-core.ts)
    CORE --> CTX(resolveCtx - ctx.messageChannel)
    CTX -->|feishu| LP(LarkCalendarProvider)
    CTX -->|slack| SP(SlackProvider)
    LP --> LAPI(飞书日历 API)
    LP --> LDIR(飞书通讯录 API)
    LP --> LDM(飞书消息 API)
    SP --> SDIR(Slack users.list API)
    SP --> SDM(Slack chat.postMessage)

    style CTX fill:#0ea5e9,color:#fff
    style LP fill:#22c55e,color:#fff
    style SP fill:#6366f1,color:#fff
```

### 插件会议流程

插件中的逐步数据流：

```mermaid
graph TD
    A(1. 用户在飞书/Slack 中发送消息) --> B(2. 网关将消息分发至 Agent LLM)
    B --> C(3. LLM 识别意图，调用 find_and_book_meeting)
    C --> D(4. resolveCtx 从 ctx.messageChannel 检测平台)
    D --> E(5. normalizeAttendees 按平台规则验证 ID)
    E --> F(6. provider.resolveUsers 根据通讯录解析姓名)
    F --> G(7. 飞行中去重 第一层 - Promise 共享)
    G --> H(8. 解析后幂等性 第二层 - SHA256 60秒窗口)
    H --> I(9. 在内存 Map 中创建 PendingMeeting)
    I --> J(10. provider.sendTextDM 向每位参与者发送邀请)
    J --> K(11. 将 meetingId 返回给 LLM，LLM 回复用户)

    style D fill:#0ea5e9,color:#fff
    style G fill:#22c55e,color:#fff
    style H fill:#22c55e,color:#fff
    style I fill:#ef4444,color:#fff
```

### 插件参与者响应流程

```mermaid
graph TD
    A(参与者收到私信邀请) --> B(在自己的私信会话中回复)
    B --> C(LLM 解析响应)
    C -->|接受| D(status = accepted)
    C -->|拒绝| E(status = declined)
    C -->|时间范围| F(status = proposed_alt + windows)
    C -->|委派| G(拒绝 + 解析委派人 + 发送新邀请)
    C -->|无关信息| H(请求澄清，不调用工具)

    D --> MERGE(合并逻辑 - 追加或替换模式)
    E --> MERGE
    F --> MERGE
    G --> MERGE

    MERGE --> CHECK(检查 pendingCount)
    CHECK -->|其他人仍在等待| WAIT(等待更多响应)
    CHECK -->|所有人已响应| DEBOUNCE(scheduleFinalize - 30秒防抖)
    DEBOUNCE -->|30秒内有新响应| RESET(clearTimeout，重启30秒)
    RESET --> DEBOUNCE
    DEBOUNCE -->|30秒已过| FINAL(finaliseMeeting)

    style MERGE fill:#0ea5e9,color:#fff
    style DEBOUNCE fill:#3b82f6,color:#fff
    style FINAL fill:#22c55e,color:#fff
```

### 插件最终确认状态机

```mermaid
stateDiagram-v2
    [*] --> 收集中: find_and_book_meeting 创建 PendingMeeting

    收集中 --> 快速路径: 所有参与者已接受
    收集中 --> 评分中: 部分参与者提出替代方案
    收集中 --> 失败: 所有人已拒绝
    收集中 --> 已过期: 12小时超时（定时器）

    快速路径 --> 已提交: commitMeeting 创建日历事件

    评分中 --> 确认中: 发起人调用 confirm_meeting_slot
    note right of 评分中: scoreSlots 按参与者覆盖率排序

    确认中 --> 已提交: 参与者确认所选时间段
    确认中 --> 失败: 时间段被拒绝

    已提交 --> [*]: 私信发起人附带事件链接
    失败 --> [*]: 私信发起人附带失败原因
    已过期 --> [*]: 私信发起人自动取消
```

### 插件后台定时器

```mermaid
graph TD
    TICK(setInterval 每60秒) --> GC(gcPending - 清理旧会议)
    GC --> LOOP(遍历每个进行中的 PendingMeeting)
    LOOP --> EXP(检查：now >= expiresAt 12小时？)
    EXP -->|是| CLOSE(关闭会议 + 私信发起人自动取消)
    EXP -->|否| STATUS(检查：距上次状态更新已过1小时？)
    STATUS -->|是| DM(私信发起人进度汇报：X/Y 已响应)
    STATUS -->|否| NEXT(下一个会议)

    style CLOSE fill:#ef4444,color:#fff
    style DM fill:#3b82f6,color:#fff
```

### 插件状态管理

所有状态存储在内存中。网关重启 = 所有进行中的会议丢失。

```
pendingMeetings: Map<string, PendingMeeting>     ← 进行中的会议
recentFindAndBook: Map<string, {meetingId, at}>   ← 幂等性（60秒窗口）
inflightFindAndBook: Map<string, Promise>         ← 并发去重
```

### 插件文件结构

```
plugin_version/
├── shared/                          claw-meeting-shared 包
│   ├── src/
│   │   ├── index.ts                 包导出
│   │   ├── plugin-core.ts           核心逻辑：7 个工具、路由、状态机（1131 行）
│   │   ├── scheduler.ts             时间段查找、评分、交集（257 行）
│   │   ├── load-env.ts              .env 加载器
│   │   └── providers/types.ts       CalendarProvider 接口
│   ├── package.json                 claw-meeting-shared
│   └── tsconfig.json
├── unified/                         多平台入口（飞书 + Slack）
│   ├── src/
│   │   ├── index.ts                 平台配置 + createMeetingPlugin()
│   │   └── providers/
│   │       ├── lark.ts              飞书后端（1020 行）
│   │       └── slack.ts             Slack 后端（346 行）
│   ├── package.json                 依赖 claw-meeting-shared
│   └── tsconfig.json
├── feishu/                          仅飞书入口
│   └── src/
│       ├── index.ts                 单平台配置
│       └── providers/lark.ts
└── slack/                           仅 Slack 入口
    └── src/
        ├── index.ts                 单平台配置
        └── providers/slack.ts
```

### 插件快速开始

```bash
cd plugin_version/shared && npm install && npm run build
cd ../unified && npm install && npm run build
openclaw plugins install -l .
openclaw gateway --force
```

---

# 第二部分：技能版 (v2.0)

## 技能架构

技能版是一个自包含的重新实现。无单仓库，无外部包依赖。所有代码在一个目录中。克隆、构建、运行。

```mermaid
graph TD
    IDX(index.ts - 入口) --> CORE(plugin-core.ts - 7 个工具)
    CORE --> ROUTER(resolveCtx - ctx.messageChannel)
    ROUTER -->|feishu| LP(LarkCalendarProvider - lark.ts)
    ROUTER -->|slack| SP(SlackProvider - slack.ts)
    CORE --> STORE(MeetingStore - meeting-store.ts)
    STORE --> MEM(内存 Map)
    STORE --> DISK(pending/*.json 文件)
    CORE --> SCHED(scheduler.ts)
    IDX --> SKILL(SKILL.md - LLM 指令)

    style ROUTER fill:#0ea5e9,color:#fff
    style STORE fill:#3b82f6,color:#fff
    style DISK fill:#22c55e,color:#fff
    style LP fill:#22c55e,color:#fff
    style SP fill:#6366f1,color:#fff
```

### 与插件版的变更对比

| 方面 | 插件版 (v1.0) | 技能版 (v2.0) |
|---|---|---|
| 代码结构 | 单仓库（shared + unified + feishu + slack） | 单目录，自包含 |
| 模块系统 | CommonJS | ESM (Node16) |
| 外部依赖 | `claw-meeting-shared` 包 | 无（全部本地导入，带 `.js` 后缀） |
| 状态层 | 仅内存 Map | MeetingStore：Map + 文件持久化 |
| `__dirname` | 原生 CJS 全局变量 | `fileURLToPath(import.meta.url)` |
| 导出方式 | `module.exports = plugin` | `export default plugin; export { plugin }` |
| SKILL.md | 无 | 包含，用于 `openclaw skills add` |

### 技能版平台路由

与插件版相同。`resolveCtx()` 读取 `ctx.messageChannel` 并路由到正确的提供者：

```mermaid
graph LR
    MSG(用户消息) --> GW(OpenClaw 网关)
    GW --> AGENT(Agent LLM)
    AGENT -->|工具调用| CORE(plugin-core.ts)
    CORE --> CTX(resolveCtx - ctx.messageChannel)
    CTX -->|feishu| LP(LarkCalendarProvider)
    CTX -->|slack| SP(SlackProvider)
    LP --> LAPI(飞书 API)
    SP --> SAPI(Slack API)

    style CTX fill:#0ea5e9,color:#fff
    style LP fill:#22c55e,color:#fff
    style SP fill:#6366f1,color:#fff
```

### 技能版会议流程

与插件版相同的业务逻辑，增加了持久化：

```mermaid
graph TD
    A(1. 用户发送消息) --> B(2. LLM 调用 find_and_book_meeting)
    B --> C(3. resolveCtx 检测平台)
    C --> D(4. 通过提供者解析参与者姓名)
    D --> E(5. 去重检查 第一层 + 第二层)
    E --> F(6. 创建 PendingMeeting)
    F --> G(7. store.save - 持久化到 pending/mtg_xxx.json)
    G --> H(8. 通过提供者发送私信邀请)
    H --> I(9. 返回给 LLM)

    I --> J(10. 参与者在私信中回复)
    J --> K(11. record_attendee_response + store.save)
    K --> L(12. 所有人已响应 - scheduleFinalize 30秒)
    L --> M(13. finaliseMeeting - 状态机)
    M --> N(14. commitMeeting + store.save)
    N --> O(15. 日历事件已创建)

    style G fill:#22c55e,color:#fff
    style K fill:#22c55e,color:#fff
    style N fill:#22c55e,color:#fff
```

绿色节点 = `store.save()` 持久化点。如果网关在任何时刻重启，状态将从 `pending/*.json` 恢复。

### 技能版状态管理

混合模式：内存用于速度，文件用于持久性。

```mermaid
graph LR
    subgraph "MeetingStore"
        MAP(内存 Map - 快速访问)
        FS(pending/mtg_xxx.json - 持久化)
    end

    WRITE(状态变更) --> MAP
    WRITE --> FS
    RESTART(网关重启) --> HYDRATE(store.hydrate)
    HYDRATE -->|扫描 pending 目录| MAP

    style MAP fill:#3b82f6,color:#fff
    style FS fill:#22c55e,color:#fff
    style HYDRATE fill:#0ea5e9,color:#fff
```

### 技能版最终确认状态机

与插件版相同：

```mermaid
stateDiagram-v2
    [*] --> 收集中: find_and_book_meeting

    收集中 --> 快速路径: 所有人已接受
    收集中 --> 评分中: 部分提出替代方案
    收集中 --> 失败: 所有人已拒绝
    收集中 --> 已过期: 12小时超时

    快速路径 --> 已提交: commitMeeting + store.save

    评分中 --> 确认中: confirm_meeting_slot
    note right of 评分中: scoreSlots 按覆盖率排序 + store.save

    确认中 --> 已提交: 所有人确认 + store.save

    已提交 --> [*]: 日历事件已创建
    失败 --> [*]: 已关闭 + store.save
    已过期 --> [*]: 自动取消 + store.save
```

### 技能版后台定时器

与插件版相同，每次状态变更时调用 `store.save()`：

```mermaid
graph TD
    TICK(setInterval 每60秒) --> GC(gcPending + gcIdempotency)
    GC --> LOOP(遍历每个进行中的会议)
    LOOP --> EXP(12小时已过期？)
    EXP -->|是| CLOSE(关闭 + 私信 + store.save)
    EXP -->|否| STATUS(距上次更新已过1小时？)
    STATUS -->|是| DM(私信进度汇报 + store.save)
    STATUS -->|否| NEXT(下一个)

    style CLOSE fill:#ef4444,color:#fff
    style DM fill:#3b82f6,color:#fff
```

### 技能版文件结构

```
skill_version/
├── SKILL.md                         LLM 行为指令
├── src/
│   ├── index.ts                     入口点 - 平台配置（70 行）
│   ├── plugin-core.ts               核心逻辑：7 个工具、路由、状态机（1176 行）
│   ├── meeting-store.ts             MeetingStore：Map + 文件持久化（222 行）
│   ├── scheduler.ts                 时间段查找、评分、交集（243 行）
│   ├── load-env.ts                  .env 加载器（ESM 兼容）
│   └── providers/
│       ├── types.ts                 CalendarProvider 接口
│       ├── lark.ts                  飞书后端（770 行）
│       └── slack.ts                 Slack 后端（345 行）
├── pending/                         运行时状态（JSON 文件，已 gitignore）
├── openclaw.plugin.json             插件 + 技能清单
├── package.json                     ESM，@slack/web-api + googleapis + luxon
└── .gitignore                       排除 .env、node_modules、dist、pending
```

### 技能版快速开始

```bash
cd skill_version
npm install
npm run build
openclaw plugins install -l .
openclaw gateway --force
```

---

# 第三部分：版本对比（差异）

## 7 个工具（两个版本共享）

| # | 工具 | 描述 |
|---|------|-------------|
| 1 | `find_and_book_meeting` | 创建待处理会议、解析参与者姓名、发送私信邀请 |
| 2 | `list_my_pending_invitations` | 列出当前发送者的待处理邀请 |
| 3 | `record_attendee_response` | 记录接受 / 拒绝 / 提出替代方案 / 委派 |
| 4 | `confirm_meeting_slot` | 发起人在评分结果后选择时间段 |
| 5 | `list_upcoming_meetings` | 列出即将到来的日历事件 |
| 6 | `cancel_meeting` | 按事件 ID 取消会议 |
| 7 | `debug_list_directory` | 列出租户通讯录用户（诊断用） |

## 配置（两个版本共享）

```env
# 飞书 / Lark
LARK_APP_ID=cli_xxxxx
LARK_APP_SECRET=xxxxx
LARK_CALENDAR_ID=xxxxx@group.calendar.feishu.cn

# Slack
SLACK_BOT_TOKEN=xoxb-xxxxx

# 调度默认值
DEFAULT_TIMEZONE=Asia/Shanghai
WORK_HOURS=09:00-18:00
LUNCH_BREAK=12:00-13:30
BUFFER_MINUTES=15
```

## 完整对比表

| 维度 | 插件版 (v1.0) | 技能版 (v2.0) |
|---|---|---|
| 架构 | 单仓库（shared + unified + feishu + slack） | 自包含（单目录） |
| 模块系统 | CommonJS | ESM (Node16) |
| 依赖 | `claw-meeting-shared` 包 | 无（全部本地） |
| 可移植性 | 需要单仓库 + 包链接 | 克隆即可运行 |
| 工具数量 | 7 | 7（相同） |
| 平台 | 飞书 + Slack | 飞书 + Slack（相同） |
| 平台路由 | 通过 `resolveCtx()` 读取 `ctx.messageChannel` | 相同 |
| 状态存储 | 内存 Map | 内存 Map + 文件持久化 |
| 重启恢复 | 所有状态丢失 | 状态保留（`pending/*.json`） |
| 协商机制 | 三阶段（收集/评分/确认） | 相同 |
| 时间段评分 | `scoreSlots()` 按覆盖率排序 | 相同 |
| 委派 | 支持（"让XXX替我去"） | 相同 |
| 30秒防抖 | `setTimeout` / `clearTimeout` | 相同 |
| 12小时超时 | `setInterval` 定时器 | 相同 |
| 两层去重 | 飞行中 Promise + SHA256 幂等性 | 相同 |
| 姓名解析 | 两步（提供者候选 + LLM 选择） | 相同 |
| 安装方式 | `openclaw plugins install` | `openclaw skills add` |
| SKILL.md | 无 | 有 |

## 变更与未变更

```mermaid
graph LR
    subgraph "技能版 v2.0 中的变更"
        D1(单仓库 → 自包含)
        D2(CommonJS → ESM)
        D3(仅内存 → 文件持久化)
        D4(包依赖 → 全部本地)
        D5(无 SKILL.md → 包含 SKILL.md)
    end

    subgraph "两个版本中相同的部分"
        S1(7 个工具)
        S2(飞书 + Slack 路由)
        S3(三阶段协商)
        S4(30秒防抖最终确认)
        S5(12小时超时定时器)
        S6(两层去重)
        S7(scoreSlots 排序)
        S8(委派支持)
        S9(两步姓名解析)
    end

    style D1 fill:#22c55e,color:#fff
    style D2 fill:#22c55e,color:#fff
    style D3 fill:#22c55e,color:#fff
    style D4 fill:#22c55e,color:#fff
    style D5 fill:#22c55e,color:#fff
    style S1 fill:#6366f1,color:#fff
    style S2 fill:#6366f1,color:#fff
    style S3 fill:#6366f1,color:#fff
    style S4 fill:#6366f1,color:#fff
    style S5 fill:#6366f1,color:#fff
    style S6 fill:#6366f1,color:#fff
    style S7 fill:#6366f1,color:#fff
    style S8 fill:#6366f1,color:#fff
    style S9 fill:#6366f1,color:#fff
```

---

## 许可证

私有 - 保留所有权利。
