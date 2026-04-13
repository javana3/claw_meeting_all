# Meeting Scheduler - OpenClaw Plugin

## Project Overview

OpenClaw plugin for scheduling meetings via natural language in IM platforms (Feishu/Lark). Users DM the bot "帮我和 XXX 安排一个会议", the plugin resolves attendees, sends invite DMs, collects responses, and auto-finalizes a calendar event.

## File Structure

```
src/
  index.ts          — Main plugin entry. PendingMeeting state machine, all 6 tools, finalize logic.
  load-env.ts       — .env loader. .env values UNCONDITIONALLY override process.env.
  scheduler.ts      — Window/intersectWindows/findSlotsInWindows helpers for time-slot computation.
  providers/
    types.ts        — CalendarProvider interface (abstract). Implement once per backend.
    lark.ts         — Feishu/Lark implementation. All Feishu API calls with citations.
    google.ts       — Google Calendar stub (not fully implemented).
```

## Architecture

### CalendarProvider Interface (providers/types.ts)

```ts
interface CalendarProvider {
  freeBusy(emails: string[], from: Date, to: Date): Promise<Record<string, BusyInterval[]>>;
  createEvent(input: CreateEventInput): Promise<CreatedEvent>;
  listUpcoming(email: string, hours: number): Promise<UpcomingEvent[]>;
  cancelEvent(eventId: string): Promise<void>;
  resolveUsers(queries: string[]): Promise<ResolvedUser[]>;
  sendTextDM?(userId: string, text: string): Promise<string>;  // Optional, Lark-only
}
```

To add a new backend (e.g. Slack + Google Calendar): implement this interface in a new provider file. The plugin selects provider based on env vars in `register()`.

### Tools Registered (index.ts)

1. **find_and_book_meeting** — Initiator calls this. Creates PendingMeeting, DMs attendees.
2. **list_my_pending_invitations** — Attendee checks their pending invites.
3. **record_attendee_response** — Records accepted/declined/proposed_alt. meetingId is OPTIONAL (auto-resolves to sender's only pending meeting).
4. **list_upcoming_meetings** — List calendar events.
5. **cancel_meeting** — Cancel by event id.
6. **debug_list_directory** — Dump tenant directory for debugging.

### PendingMeeting State Machine

```
find_and_book_meeting → PendingMeeting created (attendees: pending)
                      → DM sent to each attendee
attendee replies      → record_attendee_response updates status
                      → when all responded: scheduleFinalize (30s debounce)
finalize timer fires  → finaliseMeeting: intersect windows → createEvent → DM initiator
12h TTL               → auto-expire if not finalized
```

### Name Resolution Strategy

Plugin does NO name matching. When a display name can't be resolved:
1. Plugin fetches full tenant directory (two-stage department walk)
2. Returns all candidates to LLM as a list
3. LLM picks the best match semantically and re-calls with open_id
4. If no match, LLM asks user to clarify

## OpenClaw Configuration (openclaw.json)

### Critical Settings

```jsonc
{
  "session": {
    "dmScope": "per-channel-peer"    // MUST set. Default "main" shares session across all users → cross-user message contamination
  },
  "agents": {
    "defaults": {
      "models": {
        "volcengine-plan/kimi-k2.5": {
          "params": {
            "parallel_tool_calls": false  // MUST set. Default true → Kimi emits 60 duplicate parallel tool calls
          }
        }
      },
      "llm": {
        "idleTimeoutSeconds": 180  // Default 60 is too short for tool-heavy flows
      }
    }
  }
}
```

### Why These Matter

- **dmScope: "per-channel-peer"**: Without this, all Feishu DM users share one agent session (`agent:main:main`). Messages meant for user A get sent to user B. Valid values: `"main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer"`. Source: `plugin-sdk/src/routing/session-key.d.ts` line 35.

- **parallel_tool_calls: false**: volcengine-plan uses `api: "openai-completions"` (source: `provider-catalog-BIPalFeJ.js`). OpenAI protocol defaults `parallel_tool_calls=true`. Kimi K2.5 then emits dozens of identical parallel tool calls. The config path `agents.defaults.models[modelRef].params.parallel_tool_calls` feeds into OpenClaw's `createParallelToolCallsWrapper` (source: `pi-embedded-bukGSgEe.js` line 16612).

- **idleTimeoutSeconds: 180**: Default 60s. The idle timer resets on each streamed token, but if the model thinks slowly, total duration can exceed 60s and get killed. Source: `pi-embedded-bukGSgEe.js` line 34605 `DEFAULT_LLM_IDLE_TIMEOUT_MS = 6e4`.

## Feishu/Lark API Citations (providers/lark.ts)

All API calls are verified against `@larksuiteoapi/node-sdk` types and official docs:

| API | Method | Path |
|-----|--------|------|
| Tenant token | POST | /open-apis/auth/v3/tenant_access_token/internal |
| Batch resolve emails/phones | POST | /open-apis/contact/v3/users/batch_get_id |
| List sub-departments (recursive) | GET | /open-apis/contact/v3/departments/0/children?fetch_child=true |
| List dept members (direct only) | GET | /open-apis/contact/v3/users/find_by_department |
| Free/busy query | POST | /open-apis/calendar/v4/freebusy/list |
| Create event | POST | /open-apis/calendar/v4/calendars/{id}/events |
| Create attendees | POST | /open-apis/calendar/v4/calendars/{id}/events/{eid}/attendees |
| Send DM | POST | /open-apis/im/v1/messages |

Directory walk is two-stage: Stage A collects all dept IDs recursively, Stage B fetches members per dept and dedupes by open_id.

## Bugs Fixed (History)

1. **Shared session across users** — dmScope default "main" → all DMs share one session. Fix: `dmScope: "per-channel-peer"`.
2. **60 duplicate tool calls** — parallel_tool_calls default true on volcengine-plan. Fix: set false in model params.
3. **Triple-booking** — No idempotency on createEvent. Fix: SHA-256 idempotency_key on calendar event create.
4. **Tool-level duplicate DMs** — LLM retries find_and_book_meeting. Fix: Two-layer idempotency (in-flight Promise lock on raw params + post-resolve fingerprint with 60s TTL).
5. **find_by_department only returned root members** — API is non-recursive. Fix: Two-stage department walk.
6. **Plugin-side name matching failures** — Substring matching is unreliable. Fix: Delegate to LLM with full candidate list.
7. **Last-wins overwriting valid replies** — Fix: append mode with mergeOverlappingWindows + 30s delayed finalize.
8. **Stale env vars** — process.env from `setx` overriding .env. Fix: .env wins unconditionally.
9. **Two-step tool call too slow for attendee response** — LLM needed list_my_pending_invitations then record_attendee_response (2 inference rounds). Fix: meetingId made optional, auto-resolves to sender's only pending meeting.
10. **Fallback model (glm-4.7) doesn't call tools** — After Kimi timeout, glm-4.7 replies with text only. Partially mitigated by shorter descriptions + single-tool-call flow.

## Logging Prefixes

All plugin logs use `console.error` (captured by OpenClaw):

| Prefix | What |
|--------|------|
| `[lark.http]` | Every Feishu API call: method, path, status, elapsed |
| `[lark.resolve]` | User resolution: classify, cache hits, directory fetch, outcomes |
| `[lark.walk]` | Directory walk: per-dept member count, each user name+open_id |
| `[lark.dm]` | DM send: recipient, preview, delivered/failed |
| `[meeting-scheduler]` | Plugin business logic: tool invoked, params, state transitions, finalize |

## Environment Variables

```
LARK_APP_ID=cli_a95db04378f81cca
LARK_APP_SECRET=<in .env>
LARK_CALENDAR_ID=feishu.cn_Ww7xf9mQWdmibiwnx1cQWf@group.calendar.feishu.cn
```

## Current Status

- Feishu provider: fully working (DM, directory, calendar, name resolution)
- Initiator flow: working (create meeting, send invites, idempotency)  
- Attendee flow: partially working (tool called correctly, but Kimi K2.5 can be slow; fallback model may not call tools)
- Session isolation: fixed
- Parallel call spam: fixed
- Logging: comprehensive

## Key Principles

1. **Never guess APIs** — every Feishu/OpenClaw API must be traced to source (SDK types or dist files)
2. **Never do name matching in plugin** — delegate to LLM via candidates list
3. **Always cite sources** — line numbers in SDK types for every API shape used
4. **Defense in depth** — multiple idempotency layers, not just one
5. **Log everything** — every API call, every state transition, every decision point
