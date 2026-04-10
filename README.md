# OpenClaw Meeting Scheduler Plugin

A minimal OpenClaw plugin that lets you book meetings by chatting in any channel
your OpenClaw instance is connected to (Telegram / Slack / Feishu / DingTalk / ...).

The LLM only sees 3 high-level tools — all the time math, freebusy intersection,
work-hour rules and buffer logic happen in code, not in the prompt.

## Tools exposed

| Tool | What it does |
|---|---|
| `find_and_book_meeting`  | Find best common free slot, create event, send invites, return Meet link |
| `list_upcoming_meetings` | List the organizer's next N hours of meetings |
| `cancel_meeting`         | Cancel by event id and notify attendees |

## Setup

```bash
npm install
npm run build
```

Then install into OpenClaw (pick whichever your CLI supports):

```bash
openclaw plugins install -l .
# or
openclaw plugins install ./   # copies dist + manifest
```

## Configure

Set these in OpenClaw plugin config (declared in `openclaw.plugin.json`):

| Key | Required | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID`     | yes | OAuth client from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | yes | secret |
| `GOOGLE_REFRESH_TOKEN` | yes | one-time generate via OAuth playground |
| `ORGANIZER_EMAIL`      | yes | calendar that owns created events |
| `DEFAULT_TIMEZONE`     | no  | default `Asia/Shanghai` |
| `WORK_HOURS`           | no  | default `09:00-18:00` |
| `LUNCH_BREAK`          | no  | default `12:00-13:30` |
| `BUFFER_MINUTES`       | no  | default `15` (gap between meetings) |

How to get a refresh token quickly:
1. Enable Google Calendar API in Google Cloud Console
2. Create an OAuth 2.0 Desktop client
3. Visit https://developers.google.com/oauthplayground
4. In settings, check "Use your own OAuth credentials" and paste the client id/secret
5. Authorize scope `https://www.googleapis.com/auth/calendar`
6. Exchange the auth code for a refresh token

## Talking to it

Once installed, just chat with OpenClaw on any channel:

> "Schedule a 30-minute design review with alice@acme.com and bob@acme.com
>  sometime tomorrow afternoon. Title it 'Q2 design sync'."

OpenClaw's LLM will translate that into a `find_and_book_meeting` call:

```json
{
  "title": "Q2 design sync",
  "attendees": ["alice@acme.com", "bob@acme.com"],
  "duration_minutes": 30,
  "earliest": "2026-04-09T13:00:00+08:00",
  "latest":   "2026-04-09T18:00:00+08:00"
}
```

The plugin returns the booked slot + Google Meet link, and OpenClaw replies in the
chat with something like:

> "Booked Q2 design sync for tomorrow 14:30–15:00. Meet link: https://meet.google.com/xxx-yyyy-zzz"

Other examples that work out of the box:

- "What's on my calendar tomorrow?"     → `list_upcoming_meetings`
- "Cancel the design sync"              → `list_upcoming_meetings` → `cancel_meeting`
- "Find me 1h with the backend team this week, prefer afternoons"

## Swapping the calendar backend

Implement `CalendarProvider` from `src/providers/types.ts` for Outlook / Lark /
DingTalk and swap the constructor in `src/index.ts`. The scheduler logic stays
the same.
