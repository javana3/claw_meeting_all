# Claw Meeting

Natural-language meeting scheduler for [OpenClaw](https://github.com/openclaw/openclaw). Users DM the bot "帮我和 XXX 安排一个会议", the plugin resolves attendees, sends invite DMs, collects responses, computes mutual availability, and finalizes the meeting — all through natural conversation.

**Multi-platform**: a single plugin instance routes Feishu and Slack messages automatically. Adding Telegram, Discord, or DingTalk requires only a provider file (~200 lines) and a config entry.

## How It Works

```
User (Slack/Feishu)                     Plugin                          Attendees
       │                                   │                               │
       │  "帮我和孙润峰安排明天下午的会议"   │                               │
       │ ─────────────────────────────────>│                               │
       │                                   │  resolve "孙润峰" → user ID   │
       │                                   │  create PendingMeeting        │
       │                                   │  send invite DM ─────────────>│
       │  "已向 1 位参会人发送邀请"          │                               │
       │ <─────────────────────────────────│                               │
       │                                   │                               │
       │                                   │      "我只有 14:00-16:00 有空" │
       │                                   │ <─────────────────────────────│
       │                                   │  record response (proposed)   │
       │                                   │  all responded → 30s delay    │
       │                                   │  compute intersection         │
       │                                   │  best slot: 14:00-15:00       │
       │  "最佳时间: 04/14 14:00-15:00"    │                               │
       │ <─────────────────────────────────│                               │
```

## Features

- **Natural language** — users say "接受", "拒绝", "我只有下午3点到5点有空" in their own DM session
- **Name resolution** — pass display names, emails, or platform user IDs; plugin resolves via directory API, ambiguous names return a candidate list for the LLM to pick
- **Multi-person negotiation** — each attendee responds independently; plugin intersects all availability windows and finds the best slot
- **Append mode** — if an attendee sends multiple messages, windows are merged (not overwritten) with a 30-second debounce before finalizing
- **Idempotency** — two-layer dedup prevents duplicate meetings from parallel LLM tool calls
- **12h TTL** — meetings auto-expire with hourly status updates to the initiator
- **Platform routing** — `ctx.messageChannel` determines which provider handles each request; zero tool-name conflicts

## Project Structure

```
claw_meeting_all/
├── shared/                      # Core logic (write once, used by all platforms)
│   └── src/
│       ├── plugin-core.ts       # createMeetingPlugin() factory — state machine, 6 tools
│       ├── scheduler.ts         # Time window intersection & slot finding
│       ├── providers/types.ts   # CalendarProvider interface
│       └── load-env.ts          # .env loader
│
├── unified/                     # Multi-platform entry (recommended for production)
│   └── src/
│       ├── index.ts             # Registers feishu + slack providers (~60 lines)
│       └── providers/
│           ├── lark.ts          # Feishu/Lark: DM, directory, calendar APIs
│           └── slack.ts         # Slack: DM, directory APIs (@slack/web-api)
│
├── feishu/                      # Standalone Feishu-only entry
│   └── src/
│       ├── index.ts             # ~30 lines
│       └── providers/lark.ts
│
└── slack/                       # Standalone Slack-only entry
    └── src/
        ├── index.ts             # ~30 lines
        └── providers/slack.ts
```

## Tools Registered

| Tool | Description |
|------|-------------|
| `find_and_book_meeting` | Create a pending meeting and DM attendees |
| `list_my_pending_invitations` | Check what meetings the current user is invited to |
| `record_attendee_response` | Record accept / decline / proposed alternative times |
| `list_upcoming_meetings` | List calendar events (requires calendar backend) |
| `cancel_meeting` | Cancel a meeting by event ID |
| `debug_list_directory` | Dump the platform user directory for debugging |

## Quick Start

### 1. Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) >= 0.5.0 installed and configured
- Feishu app with bot permissions, or Slack app with `chat:write`, `users:read`, `users:read.email` scopes

### 2. Build

```bash
cd shared && npm install && npm run build
cd ../unified && npm install && npm run build
```

### 3. Configure OpenClaw

Add to `openclaw.json`:

```jsonc
{
  "plugins": {
    "load": {
      "paths": ["path/to/claw_meeting_all/unified"]
    },
    "entries": {
      "meeting-scheduler": {
        "enabled": true,
        "config": {
          // Feishu (set to enable)
          "LARK_APP_ID": "cli_xxx",
          "LARK_APP_SECRET": "your-secret",
          "LARK_CALENDAR_ID": "your-calendar-id",
          // Slack (set to enable)
          "SLACK_BOT_TOKEN": "xoxb-your-token"
        }
      }
    }
  }
}
```

### 4. Run

```bash
openclaw gateway --force
```

DM the bot in Feishu or Slack: **"帮我和 Alice 安排一个明天下午的会议"**

## Adding a New Platform

1. Create `providers/telegram.ts` implementing `CalendarProvider`:

```typescript
export class TelegramProvider implements CalendarProvider {
  async sendTextDM(userId: string, text: string): Promise<string> { /* ... */ }
  async resolveUsers(queries: string[]): Promise<ResolvedUser[]> { /* ... */ }
  // Calendar methods can be stubs initially
  async freeBusy() { throw new Error("Not configured"); }
  async createEvent() { throw new Error("Not configured"); }
  async listUpcoming() { throw new Error("Not configured"); }
  async cancelEvent() { throw new Error("Not configured"); }
}
```

2. Add to `unified/src/index.ts`:

```typescript
platforms: {
  // ... existing platforms ...
  telegram: {
    createProvider: (cfg) => new TelegramProvider({ botToken: cfg.TELEGRAM_BOT_TOKEN }),
    userIdPattern: /^\d{5,}$/,
    looksLikeUserId: (s) => /^\d{5,}$/.test(s),
    platformName: "Telegram",
    identifierExamples: "username (@xxx) or Telegram user ID",
    directoryDescription: "Telegram group member list",
  },
}
```

3. Done. Rebuild and restart OpenClaw.

## CalendarProvider Interface

```typescript
interface CalendarProvider {
  freeBusy(emails: string[], from: Date, to: Date): Promise<Record<string, BusyInterval[]>>;
  createEvent(input: CreateEventInput): Promise<CreatedEvent>;
  listUpcoming(email: string, hours: number): Promise<UpcomingEvent[]>;
  cancelEvent(eventId: string): Promise<void>;
  resolveUsers(queries: string[]): Promise<ResolvedUser[]>;
  sendTextDM?(userId: string, text: string): Promise<string>;  // Optional
}
```

## Platform Status

| Platform | DM | User Resolution | Directory | Calendar | Status |
|----------|----|----|-----------|----------|--------|
| Feishu/Lark | ✅ | ✅ email/phone/name/open_id | ✅ dept walk | ✅ full | Production |
| Slack | ✅ | ✅ email/name/user_id | ✅ users.list | ⬜ stub | DM + scheduling ready |
| Telegram | — | — | — | — | Planned |
| Discord | — | — | — | — | Planned |

## OpenClaw Configuration

```jsonc
{
  "session": {
    "dmScope": "per-channel-peer"    // CRITICAL: prevents cross-user session contamination
  },
  "agents": {
    "defaults": {
      "models": {
        "volcengine-plan/kimi-k2.5": {
          "params": {
            "parallel_tool_calls": false  // Prevents duplicate tool call spam
          }
        }
      },
      "llm": {
        "idleTimeoutSeconds": 180  // Default 60s is too short for tool-heavy flows
      }
    }
  }
}
```

## License

MIT
