# ClawMeeting - Multi-Platform Meeting Scheduler

![Version](https://img.shields.io/badge/version-2.0-blue)
![Platform](https://img.shields.io/badge/platform-Feishu%20%7C%20Slack-green)
![License](https://img.shields.io/badge/license-Private-red)
![Tools](https://img.shields.io/badge/tools-7-orange)
![Status](https://img.shields.io/badge/status-production-brightgreen)

**English** | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md)

---

## Overview

ClawMeeting is an AI-powered meeting scheduling system for OpenClaw. It coordinates multi-participant meetings across Feishu and Slack through a 3-phase negotiation protocol with intelligent time-slot scoring, automatic delegation, and debounce-controlled background polling.

Two production versions are available: **Plugin (v1.0)** using CommonJS with a shared library, and **Skill (v2.0)** using ESM with self-contained code and file-backed persistence.

---

## Architecture

```mermaid
graph TD
    A(User Request) --> B(OpenClaw Runtime)
    B --> C{ctx.messageChannel}
    C -->|feishu| D(Feishu Provider)
    C -->|slack| E(Slack Provider)
    D --> F(Calendar API)
    E --> F
    F --> G(Scheduler - Slot Finding & Scoring)
    G --> H(State Machine - 3 Phase Negotiation)
    H --> I(Meeting Confirmed)
```

---

## Plugin Version (v1.0)

The plugin version is the original production-tested implementation. It uses CommonJS modules and depends on the `claw-meeting-shared` npm package for core scheduling logic. State is held in-memory only and is lost on restart.

### Plugin Data Flow

```mermaid
graph LR
    A(Plugin Entry - index.ts) --> B(claw-meeting-shared)
    B --> C(plugin-core.ts - 7 Tools)
    C --> D{Platform Router}
    D -->|feishu| E(Lark Provider)
    D -->|slack| F(Slack Provider)
    C --> G(In-Memory State Map)
    C --> H(Scheduler - Score & Rank)
```

---

## Skill Version (v2.0)

The skill version is a reimplementation using ESM modules. All code is self-contained with no external shared library dependency. State is persisted to `pending/*.json` files, surviving restarts. Includes a `SKILL.md` for user-friendly installation.

### Skill Data Flow

```mermaid
graph LR
    A(Skill Entry - index.ts) --> B(plugin-core.ts - 7 Tools)
    B --> C{Platform Router}
    C -->|feishu| D(Lark Provider)
    C -->|slack| E(Slack Provider)
    B --> F(MeetingStore)
    F --> G(In-Memory Map)
    F --> H(pending/*.json Files)
    B --> I(Scheduler - Score & Rank)
```

---

## Meeting Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Collecting: create_meeting
    Collecting --> Collecting: add_participants
    Collecting --> Scoring: find_slots
    Scoring --> Scoring: score_slots
    Scoring --> Confirming: confirm_meeting_slot
    Confirming --> [*]: Meeting Booked
    Collecting --> [*]: cancel_meeting
    Scoring --> [*]: cancel_meeting
```

---

## Attendee Response Flow

```mermaid
graph TD
    A(Send Availability Request) --> B(Wait for Responses)
    B --> C{All Responded?}
    C -->|Yes| D(Aggregate Availability)
    C -->|No| E{Timeout?}
    E -->|No| B
    E -->|Yes| F(Proceed with Partial Data)
    D --> G(Score & Rank Slots)
    F --> G
    G --> H(Present Top Slots)
```

---

## Background Processes

```mermaid
graph TD
    A(Ticker - Periodic Poll) --> B{Active Meetings?}
    B -->|Yes| C(Check Pending Responses)
    C --> D{Debounce Window Passed?}
    D -->|Yes| E(Process Updates)
    D -->|No| F(Skip - Wait)
    B -->|No| G(Idle)
    E --> H(Update State)
    H --> I(Notify Participants)
```

---

## Tools

| # | Tool | Description |
|---|------|-------------|
| 1 | `create_meeting` | Initialize a new meeting negotiation session |
| 2 | `add_participants` | Add attendees to an existing meeting |
| 3 | `find_slots` | Query calendar availability and find open slots |
| 4 | `score_slots` | Rank candidate slots by participant preference overlap |
| 5 | `confirm_meeting_slot` | Lock in the chosen time slot and send invites |
| 6 | `cancel_meeting` | Abort a meeting negotiation and clean up state |
| 7 | `get_meeting_status` | Retrieve current state and progress of a meeting |

---

## File Structure

```
plugin_version/
├── src/
│   ├── index.ts              Entry point (platform config)
│   ├── plugin-core.ts        Core logic (7 tools, routing, state machine)
│   ├── scheduler.ts          Slot finding + scoring
│   ├── load-env.ts           .env loader
│   └── providers/
│       ├── types.ts           CalendarProvider interface
│       ├── lark.ts            Feishu backend
│       └── slack.ts           Slack backend

skill_version/
├── SKILL.md                   LLM instructions
├── src/
│   ├── index.ts              Entry point (platform config)
│   ├── plugin-core.ts        Core logic (7 tools, routing, state machine)
│   ├── meeting-store.ts      Persistent state layer
│   ├── scheduler.ts          Slot finding + scoring
│   ├── load-env.ts           .env loader (ESM)
│   └── providers/
│       ├── types.ts           CalendarProvider interface
│       ├── lark.ts            Feishu backend
│       └── slack.ts           Slack backend
├── pending/                   Runtime meeting state
```

---

## Quick Start

### Plugin Version (v1.0)

```bash
cd plugin_version
npm install
npm run build
openclaw plugins install ./
```

### Skill Version (v2.0)

```bash
cd skill_version
npm install
npm run build
openclaw skills add ./
```

---

## Configuration

Both versions require platform credentials via environment variables:

```env
# Feishu / Lark
LARK_APP_ID=cli_xxxxx
LARK_APP_SECRET=xxxxx

# Slack
SLACK_BOT_TOKEN=xoxb-xxxxx
SLACK_SIGNING_SECRET=xxxxx
```

Place a `.env` file in the respective version directory, or set variables in your shell environment.

---

## Version Comparison

| Dimension | Plugin (v1.0) | Skill (v2.0) |
|---|---|---|
| Module System | CommonJS | ESM (Node16) |
| Dependencies | claw-meeting-shared package | Self-contained |
| Tools | 7 | 7 |
| Platforms | Feishu + Slack | Feishu + Slack |
| Platform Routing | ctx.messageChannel | ctx.messageChannel |
| State Storage | In-memory Map | In-memory + file persistence |
| Restart Recovery | State lost | State preserved |
| Negotiation | 3-phase | 3-phase |
| Scoring | Yes | Yes |
| Delegation | Yes | Yes |
| Installation | `openclaw plugins install` | `openclaw skills add` |
| SKILL.md | No | Yes |

---

## License

Private - All rights reserved.
