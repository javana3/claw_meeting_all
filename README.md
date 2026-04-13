# OpenClaw Meeting Scheduler

[中文版](#中文) | [English](#english)

---

<a id="english"></a>

## English

A multi-platform meeting scheduler for OpenClaw. Schedule meetings via natural language in Feishu and Slack — the plugin automatically routes by platform.

This repository contains two versions:
- **`plugin_version/`** — Original OpenClaw Plugin (in-memory state, 6 tools)
- **`skill_version/`** — Skill-packaged Plugin with persistent state (7 tools, file-backed storage)

### Architecture Overview

```
User (Feishu/Slack)
  │
  ▼
OpenClaw Gateway
  │  routes message by ctx.messageChannel
  ▼
plugin-core.ts ── resolveCtx(ctx) ──┬── feishu ── LarkCalendarProvider (lark.ts)
                                     │              ├─ Feishu Calendar API
                                     │              ├─ Feishu Contact API (directory walk)
                                     │              └─ Feishu IM API (DM)
                                     │
                                     └── slack ─── SlackProvider (slack.ts)
                                                    ├─ Slack users.list / users.info
                                                    ├─ Slack chat.postMessage (DM)
                                                    └─ Calendar stubs (not yet implemented)
```

### Full Business Flow

```
                    ┌─────────────────────────────────────────────────┐
                    │  1. USER SENDS MESSAGE                         │
                    │  "帮我和博泽约个会, 明天下午, 30分钟"            │
                    └──────────────────┬──────────────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────────────┐
                    │  2. GATEWAY DISPATCHES TO AGENT SESSION          │
                    │  LLM (Kimi K2.5) reads SKILL.md + tool schemas │
                    │  Recognizes "约个会" → must call tool            │
                    └──────────────────┬──────────────────────────────┘
                                       │
              ┌────────────────────────▼─────────────────────────────┐
              │  3. find_and_book_meeting  (plugin-core.ts)          │
              │                                                      │
              │  a. resolveCtx(ctx) → detect platform (feishu/slack) │
              │  b. normalizeAttendees() → validate IDs per platform │
              │  c. In-flight dedup (Layer 1: Promise sharing)       │
              │  d. provider.resolveUsers() → resolve names          │
              │     ├─ Found → open_id / user_id                     │
              │     └─ Not found → return candidates to LLM          │
              │        └─ LLM picks best match → re-invokes tool     │
              │  e. Post-resolve idempotency (Layer 2: SHA256 60s)   │
              │  f. Create PendingMeeting (channel, phase=collecting)│
              │  g. store.save() → persist to pending/mtg_xxx.json   │
              │  h. provider.sendTextDM() → invite each attendee     │
              └────────────────────────┬─────────────────────────────┘
                                       │
              ┌────────────────────────▼─────────────────────────────┐
              │  4. ATTENDEE REPLIES IN THEIR DM SESSION             │
              │  "同意" / "我只有15:30-17:00有空" / "拒绝"            │
              │  LLM → record_attendee_response (plugin-core.ts)     │
              │                                                      │
              │  a. Auto-resolve meetingId (sender's only pending)   │
              │  b. Status mapping:                                  │
              │     同意/可以/行 → accepted                           │
              │     拒绝/不行   → declined                            │
              │     具体时段    → proposed_alt + windows              │
              │  c. Merge logic: append (default) or replace         │
              │  d. Delegation: "让XXX替我去" → decline + add delegate│
              │  e. store.save() → persist updated state             │
              │  f. If all responded → scheduleFinalize (30s debounce)│
              └────────────────────────┬─────────────────────────────┘
                                       │
              ┌────────────────────────▼─────────────────────────────┐
              │  5. FINALIZATION STATE MACHINE (plugin-core.ts)      │
              │                                                      │
              │  ┌─ COLLECTING ─────────────────────────────────┐    │
              │  │ All accepted? ──YES──► commitMeeting()       │    │
              │  │                         (fast path)          │    │
              │  │ Some proposed_alt? ──► scoreSlots()          │    │
              │  │   → rank by attendee coverage                │    │
              │  │   → DM initiator with ranked options         │    │
              │  │   → phase = "scoring"                        │    │
              │  └──────────────────────────────────────────────┘    │
              │                                                      │
              │  ┌─ SCORING ────────────────────────────────────┐    │
              │  │ Initiator calls confirm_meeting_slot         │    │
              │  │   → picks slot index or custom time          │    │
              │  │   → reset attendees to pending               │    │
              │  │   → DM each attendee with chosen time        │    │
              │  │   → phase = "confirming"                     │    │
              │  └──────────────────────────────────────────────┘    │
              │                                                      │
              │  ┌─ CONFIRMING ─────────────────────────────────┐    │
              │  │ Attendees accept/decline the specific slot   │    │
              │  │ All responded → commitMeeting()              │    │
              │  └──────────────────────────────────────────────┘    │
              └────────────────────────┬─────────────────────────────┘
                                       │
              ┌────────────────────────▼─────────────────────────────┐
              │  6. commitMeeting() (plugin-core.ts)                 │
              │                                                      │
              │  a. provider.createEvent() → create calendar event   │
              │     (Lark: POST /calendar/v4/calendars/.../events)   │
              │  b. provider.sendTextDM() → notify initiator         │
              │     "已锁定 15:30-16:00, 会议链接: ..."               │
              │  c. meeting.closed = true                            │
              │  d. store.save() → persist final state               │
              └──────────────────────────────────────────────────────┘
```

### Background Processes

```
┌─ TICKER (setInterval every 60s) ──────────────────────────────────┐
│                                                                    │
│  For each open PendingMeeting:                                    │
│                                                                    │
│  1. EXPIRY CHECK: now >= expiresAt (12h)?                         │
│     → close meeting, DM initiator "已超过12小时, 已自动取消"        │
│     → store.save()                                                │
│                                                                    │
│  2. STATUS UPDATE: now - lastStatusUpdateAt >= 1h?                │
│     → DM initiator roll-call "2/3 已回复, 剩余 Xh"               │
│     → store.save()                                                │
│                                                                    │
│  3. GC: remove closed meetings older than 12h from memory         │
└────────────────────────────────────────────────────────────────────┘

┌─ DEBOUNCE (setTimeout 30s per meeting) ────────────────────────────┐
│                                                                    │
│  Triggered when all attendees respond.                            │
│  New response within 30s → clearTimeout + restart                 │
│  30s elapsed → finaliseMeeting()                                  │
└────────────────────────────────────────────────────────────────────┘
```

### File Structure

```
Meeting_new/
├── docs/
│   ├── flow-diagram.md         ← Mermaid sequence diagrams
│   ├── diff.md                 ← Plugin vs Skill 6-scenario comparison
│   └── plugin-vs-skill.md      ← Architecture comparison (deprecated)
│
├── plugin_version/              ← Original Plugin (v0.2.0)
│   ├── src/
│   │   ├── index.ts             ← 1908 lines, 6 tools, single-file plugin
│   │   ├── scheduler.ts         ← Time slot algorithm
│   │   ├── load-env.ts          ← .env loader
│   │   └── providers/
│   │       ├── types.ts         ← CalendarProvider interface
│   │       ├── lark.ts          ← Feishu backend (1020 lines)
│   │       ├── google.ts        ← Google Calendar backend
│   │       └── mock.ts          ← Mock for testing
│   ├── openclaw.plugin.json
│   └── package.json
│
└── skill_version/               ← Skill-packaged Plugin (v0.3.0)
    ├── SKILL.md                 ← LLM instructions (trigger phrases, tool guide)
    ├── src/
    │   ├── index.ts             ← 70 lines, entry point (platforms config)
    │   ├── plugin-core.ts       ← 1176 lines, 7 tools, multi-platform routing
    │   ├── meeting-store.ts     ← 222 lines, in-memory Map + file persistence
    │   ├── scheduler.ts         ← 243 lines, slot finding + scoring
    │   ├── load-env.ts          ← .env loader (ESM compatible)
    │   └── providers/
    │       ├── types.ts         ← CalendarProvider interface
    │       ├── lark.ts          ← Feishu backend (770 lines)
    │       └── slack.ts         ← Slack backend (345 lines)
    ├── pending/                 ← Runtime state (persisted meetings)
    ├── openclaw.plugin.json     ← Plugin manifest + Skill declaration
    ├── package.json             ← ESM, @slack/web-api + googleapis + luxon
    └── .gitignore               ← Excludes .env, node_modules, dist, pending
```

### Version Comparison

| Feature | plugin_version | skill_version |
|---|---|---|
| Tools | 6 | 7 (+confirm_meeting_slot) |
| Platforms | Feishu only | Feishu + Slack |
| Routing | Single provider | ctx.messageChannel routing |
| State | In-memory only | In-memory + file persistence |
| Restart recovery | State lost | State preserved |
| Negotiation | Simple (accept/decline/alt) | 3-phase (collecting/scoring/confirming) |
| Scoring | No | Yes (scoreSlots) |
| Delegation | No | Yes ("让XXX替我去") |
| Module system | CommonJS | ESM (Node16) |
| Installation | `openclaw plugins install` | `openclaw skills add` (user-friendly) |

### 7 Tools

| Tool | Description | Triggers |
|---|---|---|
| `find_and_book_meeting` | Create pending meeting, resolve names, send DM invites | 约会议/帮我约/安排会议/开个会 |
| `list_my_pending_invitations` | List sender's pending invitations | (before replying to invite) |
| `record_attendee_response` | Record accept/decline/alt with merge logic | 同意/拒绝/我只有...有空 |
| `confirm_meeting_slot` | Initiator picks time slot after scoring | (after receiving scoring report) |
| `list_upcoming_meetings` | List upcoming calendar events | 我有什么会/明天有什么会 |
| `cancel_meeting` | Cancel by event ID | 取消会议 |
| `debug_list_directory` | List tenant directory users | 显示通讯录 |

### Setup

```bash
cd skill_version
npm install
npm run build
openclaw plugins install -l .
openclaw gateway --force
```

### Configuration (.env)

```
# Feishu
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_CALENDAR_ID=xxx@group.calendar.feishu.cn

# Slack
SLACK_BOT_TOKEN=xoxb-xxx

# Schedule defaults
DEFAULT_TIMEZONE=Asia/Shanghai
WORK_HOURS=09:00-18:00
LUNCH_BREAK=12:00-13:30
BUFFER_MINUTES=15
```

### Key Mechanisms

| Mechanism | Implementation | Purpose |
|---|---|---|
| In-flight dedup | `inflightFindAndBook` Map + Promise sharing | Prevent Kimi K2.5's parallel duplicate calls |
| Post-resolve idempotency | `recentFindAndBook` Map + SHA256 + 60s window | Prevent sequential retries creating duplicate meetings |
| 30s Debounce | `setTimeout` / `clearTimeout` in `scheduleFinalize()` | Give attendees time to correct responses |
| 12h TTL | Background ticker checks `expiresAt` every 60s | Auto-cancel unresponsive meetings |
| File persistence | `MeetingStore.save()` writes `pending/mtg_xxx.json` | Survive gateway restarts |
| Platform routing | `resolveCtx()` reads `ctx.messageChannel` | Route Feishu/Slack to correct provider |
| Name resolution | Provider returns candidates, LLM picks best match | Two-step resolution without fuzzy matching |
| Slot scoring | `scoreSlots()` counts attendee coverage per slot | Rank "best compromise" when not all can meet |

---

<a id="中文"></a>

## 中文

OpenClaw 多平台会议调度插件。通过飞书和 Slack 的自然语言安排会议，自动按平台路由。

本仓库包含两个版本：
- **`plugin_version/`** — 原始 OpenClaw Plugin（内存状态，6 个工具）
- **`skill_version/`** — Skill 包装的 Plugin（7 个工具，文件持久化）

### 架构概览

```
用户 (飞书/Slack)
  │
  ▼
OpenClaw Gateway
  │  按 ctx.messageChannel 路由
  ▼
plugin-core.ts ── resolveCtx(ctx) ──┬── feishu ── LarkCalendarProvider
                                     │              ├─ 飞书日历 API
                                     │              ├─ 飞书通讯录 API（部门遍历）
                                     │              └─ 飞书消息 API（私信）
                                     │
                                     └── slack ─── SlackProvider
                                                    ├─ Slack users.list / users.info
                                                    ├─ Slack chat.postMessage（私信）
                                                    └─ 日历接口（待实现）
```

### 完整业务流程

```
1. 用户发消息: "帮我和博泽约个会, 明天下午, 30分钟"
   │
   ▼
2. Gateway 分发到 agent session → LLM 识别意图 → 调用 find_and_book_meeting
   │
   ▼
3. plugin-core.ts:
   a. resolveCtx() → 检测平台（飞书/Slack）
   b. normalizeAttendees() → 按平台验证用户 ID 格式
   c. 并发去重（Layer 1: Promise 共享）
   d. provider.resolveUsers() → 解析名字
      ├─ 成功 → 得到 open_id / user_id
      └─ 失败 → 返回候选列表给 LLM → LLM 选最佳匹配 → 重新调用工具
   e. 幂等性检查（Layer 2: SHA256 60s 窗口）
   f. 创建 PendingMeeting（channel, phase=collecting）
   g. store.save() → 持久化到 pending/mtg_xxx.json
   h. provider.sendTextDM() → 给每个参会人发邀请私信
   │
   ▼
4. 参会人在各自的 DM 中回复:
   "同意" → accepted | "我只有15:30-17:00有空" → proposed_alt | "拒绝" → declined
   LLM → 调用 record_attendee_response
   a. 自动解析 meetingId
   b. 合并逻辑: append（默认，合并时段）或 replace（仅显式更正时）
   c. 委托: "让XXX替我去" → 标记拒绝 + 添加委托人
   d. store.save()
   e. 全部回复 → 触发 scheduleFinalize（30s 防抖）
   │
   ▼
5. 定稿状态机:
   ┌─ COLLECTING（收集回复）────────────────────────────┐
   │ 全部接受? → commitMeeting()（快速路径）              │
   │ 有人提出替代时段? → scoreSlots() 打分               │
   │   → 按参会人覆盖数排名 → 私信发起者排名结果          │
   │   → phase = "scoring"                              │
   └─────────────────────────────────────────────────────┘
   ┌─ SCORING（打分）────────────────────────────────────┐
   │ 发起者调用 confirm_meeting_slot 选择时段             │
   │   → 重置参会人状态 → 私信通知确认 → phase=confirming │
   └─────────────────────────────────────────────────────┘
   ┌─ CONFIRMING（确认）─────────────────────────────────┐
   │ 参会人确认/拒绝 → 全部回复 → commitMeeting()        │
   └─────────────────────────────────────────────────────┘
   │
   ▼
6. commitMeeting():
   a. provider.createEvent() → 创建日历事件
   b. provider.sendTextDM() → 通知发起者 "已锁定 15:30-16:00"
   c. meeting.closed = true → store.save()
```

### 后台进程

| 进程 | 间隔 | 作用 |
|---|---|---|
| Ticker | 每 60 秒 | 检查超时（12h）+ 定期状态更新（每 1h）+ 垃圾回收 |
| Debounce | 30 秒（每个会议） | 最后一个回复后等 30s 再定稿，给参会人纠错窗口 |

### 版本对比

| 特性 | plugin_version | skill_version |
|---|---|---|
| 工具数 | 6 | 7（+confirm_meeting_slot） |
| 平台 | 仅飞书 | 飞书 + Slack |
| 路由 | 单 provider | ctx.messageChannel 路由 |
| 状态 | 纯内存 | 内存 + 文件持久化 |
| 重启恢复 | 状态丢失 | 状态保留 |
| 协商 | 简单（接受/拒绝/替代） | 三阶段（collecting/scoring/confirming） |
| 打分 | 无 | 有（scoreSlots） |
| 委托 | 无 | 有（"让XXX替我去"） |
| 模块系统 | CommonJS | ESM（Node16） |

### 安装

```bash
cd skill_version
npm install
npm run build
openclaw plugins install -l .
openclaw gateway --force
```

### 配置 (.env)

```
# 飞书
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_CALENDAR_ID=xxx@group.calendar.feishu.cn

# Slack
SLACK_BOT_TOKEN=xoxb-xxx

# 调度默认值
DEFAULT_TIMEZONE=Asia/Shanghai
WORK_HOURS=09:00-18:00
LUNCH_BREAK=12:00-13:30
BUFFER_MINUTES=15
```

### 关键机制

| 机制 | 实现 | 用途 |
|---|---|---|
| 并发去重 | inflightFindAndBook Map + Promise 共享 | 防止 Kimi K2.5 批量重复调用 |
| 幂等性 | recentFindAndBook + SHA256 + 60s 窗口 | 防止重试创建重复会议 |
| 30s 防抖 | scheduleFinalize() 的 setTimeout/clearTimeout | 给参会人纠错时间 |
| 12h TTL | 后台 ticker 每分钟检查 expiresAt | 自动取消无人回复的会议 |
| 文件持久化 | MeetingStore.save() 写 pending/mtg_xxx.json | 重启不丢数据 |
| 平台路由 | resolveCtx() 读 ctx.messageChannel | 飞书/Slack 路由到正确的 provider |
| 名称解析 | Provider 返回候选列表，LLM 语义匹配 | 两步解析，不做模糊匹配 |
| 时段打分 | scoreSlots() 按参会人覆盖数排序 | 无法全员参加时找"最佳妥协"时段 |

## License

Private
