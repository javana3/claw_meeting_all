# AUDIT.md — source-of-truth citations

This file enumerates every external API, type, and protocol the plugin
depends on, with the exact source each claim is grounded in. There are
no "probably", "usually", or "I think"s here — if a row is in this file,
it was read out of an authoritative declaration file or official doc page.

Last audited: 2026-04-08.

---

## 1. OpenClaw plugin API

All types below come from the TypeScript declaration files shipped with the
installed OpenClaw package at
`C:/Users/dfgfd/AppData/Roaming/npm/node_modules/openclaw/dist/plugin-sdk/`.

### 1.1 Plugin entry module

**File**: `plugin-sdk/src/plugins/types.d.ts`

```ts
export type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: PluginKind | PluginKind[];
  configSchema?: OpenClawPluginConfigSchema;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
  activate?: (api: OpenClawPluginApi) => void | Promise<void>;
};
export type OpenClawPluginModule =
  OpenClawPluginDefinition
  | ((api: OpenClawPluginApi) => void | Promise<void>);
```

Used at `src/index.ts` bottom — the file does
`export default plugin; module.exports = plugin` where `plugin` is an
`OpenClawPluginDefinition`-shaped object.

### 1.2 `registerTool` signature and accepted forms

**File**: `plugin-sdk/src/plugins/types.d.ts`

```ts
registerTool: (
  tool: AnyAgentTool | OpenClawPluginToolFactory,
  opts?: OpenClawPluginToolOptions
) => void;
```

So `registerTool` accepts EITHER a tool object OR a factory function.
`src/index.ts` uses the factory form so each call gets a fresh
`OpenClawPluginToolContext` and can read the trusted sender id.

### 1.3 Factory context (where the sender comes from)

**File**: `plugin-sdk/src/plugins/types.d.ts`

```ts
export type OpenClawPluginToolContext = {
  config?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;          // regenerated on /new and /reset
  messageChannel?: string;
  agentAccountId?: string;
  deliveryContext?: DeliveryContext;
  requesterSenderId?: string;  // trusted, runtime-provided, NOT from tool args
  senderIsOwner?: boolean;
  sandboxed?: boolean;
};

export type OpenClawPluginToolFactory =
  (ctx: OpenClawPluginToolContext) =>
    AnyAgentTool | AnyAgentTool[] | null | undefined;
```

`src/index.ts` reads `ctx.requesterSenderId` inside the factory body to
auto-include the DM sender as a required attendee, BUT only if the runtime
provided it. Nothing is assumed.

### 1.4 AgentTool object shape

**File**: `openclaw/node_modules/@mariozechner/pi-agent-core/dist/types.d.ts`

```ts
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = any
> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>
  ) => Promise<AgentToolResult<TDetails>>;
}

export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
}
```

**File**: `openclaw/node_modules/@mariozechner/pi-ai/dist/types.d.ts`

```ts
import type { TSchema } from "@sinclair/typebox";
export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}
```

Used at `src/index.ts` → every tool object returned by the factory has:
- `name` (string)
- `description` (string)
- `parameters` (a JSON-Schema-shaped object cast `as any` because we do not
  take a hard dep on typebox; the runtime only inspects `.properties` /
  `.required` / `.type`)
- `label` (string) — REQUIRED by AgentTool
- `execute(toolCallId, params)` that returns
  `{ content: [{type:"text", text}], details: {...} }`

### 1.5 `execute` return type

See 1.4 above: `Promise<AgentToolResult<T>>` where
`AgentToolResult<T> = { content: (TextContent|ImageContent)[], details: T }`.

`src/index.ts` defines a small `toolResult(text, details)` helper that
produces exactly this shape.

---

## 2. Feishu Open Platform APIs

Every Feishu endpoint used by `src/providers/lark.ts` is cited against an
official open.feishu.cn documentation page.

### 2.1 tenant_access_token (internal)

**Doc**: https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal

- Method: `POST`
- URL: `https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
- Body: `{ app_id: string, app_secret: string }`
- Response: `{ code, msg, tenant_access_token, expire }` — `expire` is seconds.
  Re-issued when remaining validity < 30 min.

Used in `lark.ts` → `getToken()`.

### 2.2 Freebusy query

**Doc**: https://open.feishu.cn/document/server-docs/calendar-v4/free_busy/list

- Method: `POST`
- URL: `https://open.feishu.cn/open-apis/calendar/v4/freebusy/list`
- Query: `user_id_type` (default `open_id`)
- Body: `{ time_min: string (RFC3339), time_max: string (RFC3339), user_id?: string, room_id?: string }`
  — `user_id` and `room_id` are mutually exclusive; one user per request.
- Response: `{ code, msg, data: { freebusy_list: [{ start_time, end_time, rsvp_status }] } }`

Used in `lark.ts` → `freeBusy()`. One HTTP call is issued per attendee.

### 2.3 Create calendar event

**Doc**: https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/create

- Method: `POST`
- URL: `https://open.feishu.cn/open-apis/calendar/v4/calendars/{calendar_id}/events`
  — `{calendar_id}` must be URL-encoded.
- Body: `{ summary?, description?, start_time (time_info, required), end_time (time_info, required), vchat?, reminders?, ... }`
  where `time_info = { timestamp?: string (unix seconds), date?: string, timezone?: string }`
- Response: `{ code, msg, data: { event: { event_id, vchat?: { meeting_url }, ... } } }`

Used in `lark.ts` → `createEvent()`.

**Changed from the previous version**: removed the `vchat: { vc_type: "vc" }`
field. The doc page we extracted does not list the enum values for
`vchat.vc_type`, so we no longer set it at creation time. The consequence is
that new meetings have no auto-created video-conference link. If a link is
needed, use Lark VC API separately and patch the event afterwards.

### 2.4 Add event attendees

**Doc**: https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event-attendee/create

- Method: `POST`
- URL: `https://open.feishu.cn/open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}/attendees`
- Query: `user_id_type` (default `open_id`)
- Body: `{ attendees: [{ type: "user"|"chat"|"resource"|"third_party", user_id?: string, ... }], need_notification?: boolean }`
- Response: `{ code, msg, data: { attendees: [...] } }`

Used in `lark.ts` → `createEvent()` second leg.

### 2.5 List events

**Doc**: https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/list

- Method: `GET`
- URL: `https://open.feishu.cn/open-apis/calendar/v4/calendars/{calendar_id}/events`
- Query: `start_time`, `end_time` (unix seconds as strings)

Used in `lark.ts` → `listUpcoming()`.

### 2.6 Delete event

**Doc**: https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/delete

- Method: `DELETE`
- URL: `https://open.feishu.cn/open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}`

Used in `lark.ts` → `cancelEvent()`.

### 2.7 Batch get user id (email / mobile → open_id)

**Doc**: https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id

- Method: `POST`
- URL: `https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id`
- Query: `user_id_type` (default `open_id`; other valid values: `union_id`, `user_id`)
- Body: `{ emails?: string[] (max 50), mobiles?: string[] (max 50), include_resigned?: boolean }`
- Response: `{ code, msg, data: { user_list: [{ user_id, email?, mobile?, status }] } }`
- Required permission: `contact:user.id:readonly`

Used in `lark.ts` → `resolveUsers()` for email and phone queries.

### 2.8 Search user by display name — **DOES NOT EXIST**

Verified via:
- https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id
  (only accepts `emails[]` / `mobiles[]`)
- https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department
  (requires a `department_id`, not a name)
- Web search of `site:open.feishu.cn 搜索用户 姓名` returned only
  batch_get_id, find_by_department, user/get (by user_id), and FAQ pages
  about obtaining open_ids. No name-search endpoint.

**Consequence**: `lark.ts` previously contained a call to
`/open-apis/search/v1/user?query={name}`. That endpoint was **fabricated**
by me and does not exist in the Feishu contact v3 surface. The call has
been removed. `resolveUsers()` now returns `via: "unresolved"` for any
string classified as a display name, and `index.ts` surfaces a clear
error message to the LLM so the agent can ask the user for a valid
identifier instead of hallucinating one.

---

## 3. `channels.feishu` config shape (websocket mode)

**File**: `openclaw/dist/channel-DqcLIU8I.js`

The relevant zod schema exists as compiled JS. The fields we depend on
are confirmed by `grep` in that file:

- `appId`, `appSecret` — required base credentials
- `encryptKey`, `verificationToken` — required only for webhook mode
- `domain` — `"feishu" | "lark" | https URL`
- `connectionMode` — `"websocket" | "webhook"`, default `"websocket"`
- `webhookPath` — default `/feishu/events`

`~/.openclaw/openclaw.json` currently has:

```json
"channels": {
  "feishu": {
    "enabled": true,
    "appId": "cli_...",
    "appSecret": "...",
    "domain": "feishu",
    "connectionMode": "websocket"
  }
}
```

`resolveFeishuBaseCredentials()` (also in `channel-DqcLIU8I.js`) reads
`cfg.channels.feishu.appId` / `cfg.channels.feishu.appSecret` directly,
which is why the flat placement above works. The previous version of
the config nested these under `accounts.default.config`, which did NOT
match the merge logic in `mergeFeishuAccountConfig` in the same file,
so credentials resolved to `undefined` and `getToken()` threw.

The `accounts.default.config` shape **was guessed** by me originally,
and it was wrong. The flat form is the one the compiled code actually
reads.

---

## 4. What I previously fabricated and have now removed

| # | Previously in code | What it did | Fixed by |
|---|---|---|---|
| 1 | `declare const definePluginEntry` | Wrapped the plugin export in a function that does not exist as a global | Plain `export default { id, name, register }` per `OpenClawPluginDefinition` |
| 2 | `handler: async (p) => {...}` on tool objects | Assumed the tool handler field was `handler` | Renamed to `execute` per `AgentTool.execute` |
| 3 | `execute: async (arg1, arg2, arg3) => {...}` + grabbing params from arg1 | Assumed all of `(arg1, arg2, arg3)` were candidate param bags | Proper signature `(toolCallId, params, signal?, onUpdate?)` — `arg1` is the call id string, `arg2` is the params object |
| 4 | `extractSenderOpenId(arg1, arg2, arg3)` scanning for `sender.id` / `from` / `senderOpenId` / `open_id` | Guessed OpenClaw might pass sender via execute args | Switched the registration to the **factory form** and read `ctx.requesterSenderId` which is the documented trusted source |
| 5 | `normalizeAttendees(list, sender)` replacing `"self"` / `"me"` / `"我"` with sender | Invented placeholder protocol | Removed. Tool description now says "never fabricate ids" and "pass email / phone / open_id" |
| 6 | `provider.createEvent({ vchat: { vc_type: "vc" }, reminders: [{minutes:10}] })` | `vc_type: "vc"` string and `reminders: [{minutes:10}]` shape were guesses | Removed both. If a join URL is needed later, wire Lark VC API separately |
| 7 | `"/open-apis/search/v1/user?query=张三"` in `resolveUsers()` | Fabricated endpoint for name → open_id resolution | Removed. Names are returned `unresolved` |
| 8 | `channels.feishu.accounts.default.config.{appId,appSecret,...}` | Guessed that per-account nested `config` field existed | Flattened to `channels.feishu.{appId, appSecret, ...}` per `mergeFeishuAccountConfig` in `channel-DqcLIU8I.js` |
| 9 | Returning plain `{ ok, eventId }` from `execute` | Ignored the documented `AgentToolResult<T>` envelope | All tool returns go through `toolResult(text, details)` → `{content: [{type:"text", text}], details}` |
| 10 | `DEFAULT_ORGANIZER_OPEN_ID` env var fallback | Defaulted sender to a hardcoded open_id when ctx had nothing | Removed. If `ctx.requesterSenderId` is missing and the LLM passes zero attendees, the tool returns an explicit `no_attendees` error |

---

## 5. What the plugin still needs the user to do manually

These are the environmental dependencies that must exist for the plugin
to function. Nothing below is code we control.

1. **Feishu app permissions** (granted and published as a new version):
   - `calendar:calendar.free_busy:read`
   - `calendar:calendar` (or the narrower read/event subset)
   - `contact:user.id:readonly` (for batch_get_id)

2. **`.env` file** at project root with:
   - `LARK_APP_ID`
   - `LARK_APP_SECRET`
   - `LARK_CALENDAR_ID` (bot-owned calendar id)
   - `DEFAULT_TIMEZONE` (default `Asia/Shanghai`)
   - `WORK_HOURS`, `LUNCH_BREAK`, `BUFFER_MINUTES` (scheduling policy)

3. **OpenClaw config** `~/.openclaw/openclaw.json`:
   - `agents.defaults.model.primary` pointing at a model the user has
     actually activated in Volcengine Ark (Coding Plan or pay-per-token)
   - `channels.feishu.{appId, appSecret, domain, connectionMode}` for the
     DM transport
   - `plugins.entries.feishu.enabled: true`
   - `plugins.installs["meeting-scheduler"]` pointing at this project dir

4. **Feishu developer console** event subscription:
   - Mode: "Long connection (长连接)" — websocket, no public URL needed
   - Subscribe to `im.message.receive_v1`

5. **Network**: `ark.cn-beijing.volces.com` and `open.feishu.cn` must be
   directly reachable from the host. If a VPN is running, both hosts must
   be in DIRECT / bypass rules, not routed through a foreign proxy, or
   LLM requests will time out.

---

## 6. What is still NOT verified in this audit

I am flagging these honestly instead of papering over them:

1. **How OpenClaw actually serialises `parameters` before sending to the
   provider.** The `parameters` field's TS type is `TSchema`
   (`@sinclair/typebox`), but we cast a plain JSON-Schema-shaped object
   `as any`. Empirically this works because the compiled runner accepts
   it, but if a future OpenClaw version tightens the runtime check we
   will need to add typebox as a dep and use `Type.Object({...})`.

2. **The `AgentToolResult.details` field.** The TS declares it generic
   `T`, and the runner appears to pass it through. We return plain
   plain-object details, which is consistent with the declaration but
   not explicitly guaranteed to be rendered anywhere by the UI.

3. **Whether `ctx.requesterSenderId` is populated for Feishu DM-sourced
   tool calls.** The TS declares it as optional, and we handle the
   `undefined` case safely. If it turns out the Feishu channel does not
   populate it, the user-facing behaviour is: the LLM MUST be given
   attendees explicitly every time. That is a survivable limitation.

4. **The `reminders` shape and any other optional fields on the Feishu
   create-event request body.** I stopped including them — if a future
   version of the plugin wants per-user reminder offsets, they must be
   re-derived from the docs and cited here.
