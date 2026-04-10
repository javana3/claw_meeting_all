# OpenClaw Meeting Scheduler Plugin

[中文版](#中文) | [English](#english)

---

<a id="english"></a>

## English

An OpenClaw plugin for scheduling meetings via natural language in Feishu / Slack and other IM channels.

All time math (free-busy intersection, work-hour filtering, buffer logic) runs in code -- the LLM only handles intent parsing and parameter extraction.

### Workflow

1. User says "Schedule a 30-min standup with Alice and Bob tomorrow morning" in any connected channel
2. LLM calls `find_and_book_meeting` -- the plugin creates a **Pending Meeting** and DMs each attendee
3. Attendees reply in their own DM session (accept / suggest alternative / decline)
4. Once all responses are in, the plugin auto-computes the best slot and creates the calendar event

### Tools

| Tool | Description |
|---|---|
| `find_and_book_meeting` | Create a pending meeting and send invitation DMs to attendees |
| `list_my_pending_invitations` | List pending invitations for the current user |
| `record_attendee_response` | Record an attendee's reply (accept / alternative / decline) |
| `list_upcoming_meetings` | List the organizer's upcoming schedule |
| `cancel_meeting` | Cancel a meeting and notify attendees |
| `debug_list_directory` | Debug: list Feishu tenant directory |

### Setup

```bash
npm install
npm run build
openclaw plugins install -l .
```

### Configuration

Set in `openclaw.plugin.json` or `.env`:

#### Lark (Feishu) Backend

| Key | Required | Description |
|---|---|---|
| `LARK_APP_ID` | Yes | Feishu app ID (cli_xxx) |
| `LARK_APP_SECRET` | Yes | Feishu app secret |
| `LARK_CALENDAR_ID` | Yes | Calendar ID to write events into; the app must have edit access |

#### Google Calendar Backend

| Key | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Yes | Generated via OAuth Playground |
| `ORGANIZER_EMAIL` | Yes | Email of the calendar owner |

#### General

| Key | Default | Description |
|---|---|---|
| `DEFAULT_TIMEZONE` | `Asia/Shanghai` | Default timezone |
| `WORK_HOURS` | `09:00-18:00` | Working hours range |
| `LUNCH_BREAK` | `12:00-13:30` | Lunch break |
| `BUFFER_MINUTES` | `15` | Buffer between meetings (minutes) |

### Usage Examples

```
"Schedule a 30-min design review with alice@acme.com tomorrow afternoon"
"Book 1 hour with the backend team this week, prefer mornings"
"What's on my calendar tomorrow?"
"Cancel the design review"
```

### Attendee Name Resolution

The plugin accepts multiple identifier formats -- pass them exactly as the user said:
- Display names in Chinese or English (e.g. "Alice", "博泽")
- Email addresses
- Phone numbers
- Feishu open_id

Name resolution is a two-step process: the plugin queries the Feishu tenant directory and returns a candidate list; the LLM picks the best match by semantic understanding.

### Extending Calendar Backends

Implement the `CalendarProvider` interface in `src/providers/types.ts` to integrate Outlook / DingTalk or other calendar systems. The scheduling logic stays the same.

### Tech Stack

- TypeScript
- [Luxon](https://moment.github.io/luxon/) -- timezone and date math
- [Google APIs](https://github.com/googleapis/google-api-nodejs-client) -- Google Calendar integration
- OpenClaw Plugin SDK

---

<a id="中文"></a>

## 中文

OpenClaw 会议调度插件 -- 通过飞书 / Slack 等 IM 频道用自然语言安排会议。

插件负责全部时间计算（空闲时段交集、工作时间过滤、缓冲间隔），LLM 只做意图理解和参数提取。

### 工作流程

1. 用户在 IM 中说"帮我和 Alice、Bob 约明天下午的会，30 分钟"
2. LLM 调用 `find_and_book_meeting`，插件创建一个 **Pending Meeting** 并私信每位参会人
3. 参会人在各自的 DM 会话中回复可用时间（同意 / 提出替代时段 / 拒绝）
4. 所有人回复后，插件自动计算最佳时段并在日历上创建事件

### 工具列表

| 工具 | 说明 |
|---|---|
| `find_and_book_meeting` | 创建 pending meeting，向参会人发送邀请 DM |
| `list_my_pending_invitations` | 查看当前用户收到的待处理邀请 |
| `record_attendee_response` | 记录参会人的回复（同意 / 替代时段 / 拒绝） |
| `list_upcoming_meetings` | 查看组织者接下来的日程 |
| `cancel_meeting` | 取消会议并通知参会人 |
| `debug_list_directory` | 调试用：列出飞书租户通讯录 |

### 安装

```bash
npm install
npm run build
openclaw plugins install -l .
```

### 配置

在 `openclaw.plugin.json` 或 `.env` 中设置：

#### 飞书（Lark）后端

| Key | 必填 | 说明 |
|---|---|---|
| `LARK_APP_ID` | 是 | 飞书应用 ID (cli_xxx) |
| `LARK_APP_SECRET` | 是 | 飞书应用密钥 |
| `LARK_CALENDAR_ID` | 是 | 写入事件的日历 ID，应用需有编辑权限 |

#### Google Calendar 后端

| Key | 必填 | 说明 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | 是 | Google OAuth 客户端 ID |
| `GOOGLE_CLIENT_SECRET` | 是 | OAuth 客户端密钥 |
| `GOOGLE_REFRESH_TOKEN` | 是 | 通过 OAuth Playground 生成 |
| `ORGANIZER_EMAIL` | 是 | 创建事件的日历所有者邮箱 |

#### 通用配置

| Key | 默认值 | 说明 |
|---|---|---|
| `DEFAULT_TIMEZONE` | `Asia/Shanghai` | 默认时区 |
| `WORK_HOURS` | `09:00-18:00` | 工作时间范围 |
| `LUNCH_BREAK` | `12:00-13:30` | 午休时间 |
| `BUFFER_MINUTES` | `15` | 会议间缓冲（分钟） |

### 使用示例

```
"帮我和博泽、子岩安排后天上午的会议，30分钟，主题是站会"
"明天下午帮我约一个小时的设计评审，参会人 alice@acme.com"
"我明天有什么会？"
"取消设计评审"
```

### 参会人名称解析

插件支持多种标识符格式，按用户原话传入即可：
- 中英文显示名（如"博泽"、"Alice"）
- 邮箱地址
- 手机号
- 飞书 open_id

名称解析采用两步流程：插件从飞书通讯录返回候选列表，由 LLM 根据语义选择最佳匹配。

### 扩展日历后端

实现 `src/providers/types.ts` 中的 `CalendarProvider` 接口即可接入 Outlook / DingTalk 等日历系统，调度逻辑不变。

### 技术栈

- TypeScript
- [Luxon](https://moment.github.io/luxon/) -- 时区与日期计算
- [Google APIs](https://github.com/googleapis/google-api-nodejs-client) -- Google Calendar 集成
- OpenClaw Plugin SDK

## License

Private
