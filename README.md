<div align="center">

# OpenClaw Meeting Scheduler

**Multi-platform AI meeting scheduler for OpenClaw**

Schedule meetings via natural language in Feishu and Slack.
The plugin automatically routes by platform, resolves attendee names, collects availability via DM, scores time slots, and creates calendar events.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![OpenClaw](https://img.shields.io/badge/OpenClaw-Plugin%20%2B%20Skill-FF6B35)
![Feishu](https://img.shields.io/badge/Feishu-Supported-00D09C?logo=bytedance&logoColor=white)
![Slack](https://img.shields.io/badge/Slack-Supported-4A154B?logo=slack&logoColor=white)
![License](https://img.shields.io/badge/License-Private-red)
![Version](https://img.shields.io/badge/Version-2.0.0-blue)

**English** | [中文](./README.zh-CN.md)

</div>

---

## Overview

This repository contains two versions of the meeting scheduler:

| | `plugin_version/` | `skill_version/` |
|---|---|---|
| **Architecture** | OpenClaw Plugin (CJS) | Skill-packaged Plugin (ESM) |
| **Tools** | 6 | 7 (+slot confirmation) |
| **Platforms** | Feishu only | Feishu + Slack |
| **State** | In-memory (lost on restart) | File-persistent (survives restart) |
| **Negotiation** | Simple accept/decline | 3-phase scoring + confirmation |
| **Installation** | `openclaw plugins install` | `openclaw skills add` |

## Architecture

```mermaid
graph TB
    subgraph Users
        U1(Feishu User)
        U2(Slack User)
    end

    subgraph OpenClaw Gateway
        GW(Gateway)
        AG(Agent LLM)
    end

    subgraph Meeting Scheduler Plugin
        PC(plugin-core.ts)
        RC{resolveCtx}
        MS[(MeetingStore)]

        subgraph Feishu Provider
            LP(lark.ts)
            LCAL(Calendar API)
            LDIR(Contact API)
            LDM(IM API)
        end

        subgraph Slack Provider
            SP(slack.ts)
            SDIR(users.list)
            SDM(chat.postMessage)
        end

        SCH(scheduler.ts)
    end

    U1 -->|message| GW
    U2 -->|message| GW
    GW -->|dispatch| AG
    AG -->|tool call| PC
    PC --> RC
    RC -->|channel=feishu| LP
    RC -->|channel=slack| SP
    LP --> LCAL
    LP --> LDIR
    LP --> LDM
    SP --> SDIR
    SP --> SDM
    PC --> SCH
    PC <-->|read/write| MS

    style RC fill:#f59e0b,color:#000
    style MS fill:#3b82f6,color:#fff
    style LP fill:#00D09C,color:#fff
    style SP fill:#4A154B,color:#fff
    style SCH fill:#8b5cf6,color:#fff
```

## Meeting Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Collecting: find_and_book_meeting
    note right of Collecting: DM each attendee\nfor availability

    Collecting --> FastPath: All accepted
    Collecting --> Scoring: Some proposed alternatives
    Collecting --> Cancelled: All declined
    Collecting --> Expired: 12h timeout

    FastPath --> Committed: commitMeeting()

    Scoring --> Confirming: Initiator picks slot\n(confirm_meeting_slot)
    note right of Scoring: scoreSlots() ranks\nby attendee coverage

    Confirming --> Committed: All confirm chosen slot
    Confirming --> Cancelled: Declined

    Committed --> [*]: Calendar event created
    Cancelled --> [*]: Meeting closed
    Expired --> [*]: Auto-cancelled
```

## Request Processing Pipeline

```mermaid
flowchart LR
    subgraph "1. Message Received"
        MSG(User Message)
    end

    subgraph "2. Intent Recognition"
        LLM(LLM parses intent)
    end

    subgraph "3. Platform Routing"
        CTX{ctx.messageChannel}
        F(Feishu Provider)
        S(Slack Provider)
    end

    subgraph "4. Name Resolution"
        NR{resolveUsers}
        DIR(Directory Walk)
        CAND(Return Candidates)
        PICK(LLM Picks Match)
    end

    subgraph "5. Meeting Creation"
        DUP{Dedup Check}
        PM(Create PendingMeeting)
        DM(Send DM Invites)
        SAVE(store.save)
    end

    MSG --> LLM --> CTX
    CTX -->|feishu| F
    CTX -->|slack| S
    F --> NR
    S --> NR
    NR -->|found| DUP
    NR -->|not found| DIR --> CAND --> PICK -->|re-invoke| NR
    DUP -->|new| PM --> DM --> SAVE
    DUP -->|duplicate| RET(Return existing ID)

    style CTX fill:#f59e0b,color:#000
    style DUP fill:#ef4444,color:#fff
    style SAVE fill:#3b82f6,color:#fff
```

## Attendee Response Flow

```mermaid
flowchart TD
    REPLY(Attendee replies in DM) --> PARSE{LLM parses response}

    PARSE -->|"同意/可以/行"| ACC(status = accepted)
    PARSE -->|"拒绝/不行"| DEC(status = declined)
    PARSE -->|"15:30-17:00有空"| ALT(status = proposed_alt)
    PARSE -->|"让XXX替我去"| DEL(Delegation)
    PARSE -->|"random noise"| IGN(Ask for clarification)

    ACC --> MERGE{Merge Mode}
    DEC --> MERGE
    ALT --> MERGE

    DEL --> D1(Mark original: declined)
    D1 --> D2(Resolve delegate name)
    D2 --> D3(Add delegate as pending)
    D3 --> D4(DM delegate with invite)

    MERGE -->|append default| UNION(Union windows)
    MERGE -->|replace| OVERWRITE(Overwrite previous)

    UNION --> CHECK{All responded?}
    OVERWRITE --> CHECK

    CHECK -->|No| WAIT(Wait for others)
    CHECK -->|Yes| DEBOUNCE(30s debounce timer)

    DEBOUNCE -->|New response in 30s| RESET(Reset timer)
    RESET --> DEBOUNCE
    DEBOUNCE -->|30s elapsed| FINAL(finaliseMeeting)

    style ACC fill:#22c55e,color:#fff
    style DEC fill:#ef4444,color:#fff
    style ALT fill:#f59e0b,color:#000
    style DEL fill:#8b5cf6,color:#fff
    style DEBOUNCE fill:#3b82f6,color:#fff
```

## Background Processes

```mermaid
flowchart LR
    subgraph "Ticker (every 60s)"
        T1(Check all open meetings)
        T2{now >= expiresAt?}
        T3(Close + DM initiator)
        T4{Status update due?}
        T5(DM roll-call to initiator)
        T6(GC expired meetings)
    end

    T1 --> T2
    T2 -->|Yes, 12h passed| T3
    T2 -->|No| T4
    T4 -->|Yes, 1h since last| T5
    T4 -->|No| T6

    style T3 fill:#ef4444,color:#fff
    style T5 fill:#3b82f6,color:#fff
```

## Safety Mechanisms

```mermaid
flowchart TD
    subgraph "Concurrent Dedup (Layer 1)"
        L1(60 parallel tool calls)
        L1P(inflightFindAndBook Map)
        L1R(Share single Promise)
        L1 --> L1P --> L1R
    end

    subgraph "Idempotency (Layer 2)"
        L2(Sequential retry)
        L2H(SHA256 fingerprint)
        L2W(60s window check)
        L2 --> L2H --> L2W
    end

    subgraph "Debounce"
        DB1(Last response received)
        DB2(setTimeout 30s)
        DB3{New response?}
        DB4(clearTimeout + restart)
        DB5(finaliseMeeting)
        DB1 --> DB2 --> DB3
        DB3 -->|Yes| DB4 --> DB2
        DB3 -->|No, 30s elapsed| DB5
    end

    subgraph "Persistence"
        PS1(State mutation)
        PS2(store.save to JSON)
        PS3(Gateway restart)
        PS4(store.hydrate from disk)
        PS1 --> PS2
        PS3 --> PS4
    end

    style L1R fill:#22c55e,color:#fff
    style L2W fill:#22c55e,color:#fff
    style DB5 fill:#3b82f6,color:#fff
    style PS4 fill:#3b82f6,color:#fff
```

## File Structure

```
Meeting_new/
├── docs/
│   ├── flow-diagram.md              Mermaid sequence diagrams
│   ├── diff.md                      Plugin vs Skill 6-scenario analysis
│   └── plugin-vs-skill.md           Architecture comparison
│
├── plugin_version/                   Original Plugin (v1.0)
│   ├── src/
│   │   ├── index.ts                  1908 lines, 6 tools, single-file
│   │   ├── scheduler.ts             Time slot algorithm
│   │   └── providers/
│   │       ├── lark.ts              Feishu backend (1020 lines)
│   │       ├── google.ts            Google Calendar backend
│   │       └── mock.ts             Test mock
│   └── openclaw.plugin.json
│
└── skill_version/                    Skill-packaged Plugin (v2.0)
    ├── SKILL.md                      LLM instructions
    ├── src/
    │   ├── index.ts                  Entry point (platform config)
    │   ├── plugin-core.ts            1176 lines, 7 tools, multi-platform
    │   ├── meeting-store.ts          Persistent state layer
    │   ├── scheduler.ts             Slot finding + scoring
    │   └── providers/
    │       ├── lark.ts              Feishu (770 lines)
    │       └── slack.ts             Slack (345 lines)
    ├── pending/                      Runtime meeting state
    └── openclaw.plugin.json         Plugin + Skill manifest
```

## 7 Tools

| Tool | Description | Trigger Phrases |
|---|---|---|
| `find_and_book_meeting` | Create pending meeting, resolve names, send DM invites | 约会议 / 帮我约 / 安排会议 / 开个会 |
| `list_my_pending_invitations` | List sender's pending invitations | (before replying to invite) |
| `record_attendee_response` | Record accept / decline / alternative with merge logic | 同意 / 拒绝 / 我只有...有空 |
| `confirm_meeting_slot` | Initiator picks time slot after scoring | (after receiving scoring report) |
| `list_upcoming_meetings` | List upcoming calendar events | 我有什么会 / 明天有什么会 |
| `cancel_meeting` | Cancel by event ID | 取消会议 |
| `debug_list_directory` | List tenant directory users | 显示通讯录 |

## Quick Start

```bash
cd skill_version
npm install
npm run build
openclaw plugins install -l .
openclaw gateway --force
```

## Configuration (.env)

```env
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

## License

Private
