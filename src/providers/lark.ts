/**
 * Lark / Feishu Calendar provider.
 *
 * ===========================================================================
 * SOURCE-OF-TRUTH CITATIONS
 * ===========================================================================
 * Every endpoint, query parameter, request field, and response field in this
 * file is cross-checked against `@larksuiteoapi/node-sdk/types/index.d.ts`
 * (the official Feishu SDK type declarations shipped inside the installed
 * OpenClaw feishu extension at
 *   openclaw/dist/extensions/feishu/node_modules/@larksuiteoapi/node-sdk/
 * ). Each section below cites the line numbers in that file plus the public
 * doc URL the SDK embedded as a JSDoc `@link` comment.
 *
 * 1. tenant_access_token (internal)
 *    SDK: (not in calendar module — HTTP call, not SDK-wrapped here)
 *    Doc: https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
 *    POST /open-apis/auth/v3/tenant_access_token/internal
 *    Body: { app_id: string, app_secret: string }
 *    Resp: { code, msg, tenant_access_token, expire }  // expire is seconds
 *
 * 2. Freebusy list (single user per call)
 *    SDK: types/index.d.ts line 30178-30199, `calendar.freebusy.list`
 *    Doc: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/freebusy/list
 *    POST /open-apis/calendar/v4/freebusy/list
 *    Query: user_id_type = "user_id" | "union_id" | "open_id"
 *    Body:  { time_min: string, time_max: string,
 *             user_id?: string, room_id?: string,      // mutually exclusive
 *             include_external_calendar?: boolean,
 *             only_busy?: boolean }
 *    Resp:  { code, msg, data: { freebusy_list?: [{ start_time, end_time }] } }
 *    NOTE:  time_min/time_max are RFC3339 strings with offset.
 *
 * 2b. Freebusy batch (multi-user per call, preferred for N>1 attendees)
 *    SDK: types/index.d.ts line 30145-30168, `calendar.freebusy.batch`
 *    POST /open-apis/calendar/v4/freebusy/batch
 *    Query: user_id_type = ...
 *    Body:  { time_min, time_max, user_ids: string[],
 *             include_external_calendar?, only_busy? }
 *    Resp:  { code, msg, data: { freebusy_lists?: [
 *             { user_id?: string,
 *               freebusy_items?: [{ start_time, end_time }] }
 *           ] } }
 *
 * 3. Calendar event create
 *    SDK: types/index.d.ts line 28974-29160, `calendar.calendarEvent.create`
 *    Doc: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar-event/create
 *    POST /open-apis/calendar/v4/calendars/{calendar_id}/events
 *    Path:  calendar_id (URL-encoded)
 *    Query: idempotency_key?  (CRITICAL: de-dupes concurrent/retry creates;
 *             SDK line 28056-28057),
 *           user_id_type?
 *    Body:  { summary?, description?, need_notification?,
 *             start_time: { timestamp?: string /* unix seconds * /,
 *                           date?: string /* YYYY-MM-DD * /,
 *                           timezone?: string },
 *             end_time:   { ... same shape ... },
 *             vchat?, visibility?, attendee_ability?,
 *             free_busy_status?, location?, color?, reminders?, ... }
 *    Resp:  { code, msg, data: { event: { event_id: string, ... } } }
 *
 * 4. Event attendee create
 *    SDK: types/index.d.ts line 28721-28788, `calendar.calendarEventAttendee.create`
 *    Doc: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar-event-attendee/create
 *    POST /open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}/attendees
 *    Query: user_id_type?
 *    Body:  { attendees?: [{
 *               type?: "user" | "chat" | "resource" | "third_party",
 *               is_optional?: boolean,
 *               user_id?: string, chat_id?, room_id?, third_party_email?,
 *               operate_id?, approval_reason? }],
 *             need_notification?: boolean,
 *             add_operator_to_attendee?: boolean, ... }
 *    Resp:  { code, msg, data: { attendees?: [...] } }
 *
 * 5. Calendar event list
 *    SDK: types/index.d.ts line 29481-29563, `calendar.calendarEvent.list`
 *    Doc: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar-event/list
 *    GET  /open-apis/calendar/v4/calendars/{calendar_id}/events
 *    Query: page_size?, anchor_time?, page_token?, sync_token?,
 *           start_time?, end_time?, user_id_type?
 *    Resp:  { code, msg, data: { has_more?, page_token?, sync_token?,
 *             items?: [{ event_id, summary?, start_time, end_time, ... }] } }
 *    NOTE:  start_time/end_time query params are unix-seconds strings.
 *
 * 6. Calendar event delete
 *    SDK: types/index.d.ts line 29172-29184, `calendar.calendarEvent.delete`
 *    Doc: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar-event/delete
 *    DELETE /open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}
 *    Query: need_notification?: "true" | "false"   // NOTE: string, not boolean
 *    Resp:  { code, msg, data: {} }
 *
 * 7. Contact batch_get_id (email / mobile -> open_id)
 *    SDK: types/index.d.ts line 36411-36437, `contact.user.batchGetId`
 *    Doc: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/batch_get_id
 *    POST /open-apis/contact/v3/users/batch_get_id
 *    Query: user_id_type = "open_id" | "union_id" | "user_id"
 *    Body:  { emails?: string[], mobiles?: string[], include_resigned?: boolean }
 *    Resp:  { code, msg, data: { user_list?: [
 *             { user_id?: string, email?: string, mobile?: string,
 *               status?: { is_frozen?, is_resigned?, is_activated?,
 *                          is_exited?, is_unjoin? } }
 *           ] } }
 *    NOTE:  Feishu has NO search-by-display-name endpoint. Name queries
 *           are returned as unresolved so the caller surfaces a clear error.
 *
 * 8. IM message create (DM from bot to user, for meeting invitations and
 *    status updates)
 *    SDK: types/index.d.ts `im.v1.message.create`
 *         lib/index.js line 60558-60572 (runtime URL + method)
 *    Doc: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create
 *    POST /open-apis/im/v1/messages
 *    Query: receive_id_type = "open_id" | "user_id" | "union_id" | "email" | "chat_id"  (REQUIRED)
 *    Body:  { receive_id: string, msg_type: string, content: string /* JSON-encoded * /,
 *             uuid?: string /* 1h dedup window * / }
 *    For a text message: msg_type="text", content=JSON.stringify({ text: "..." })
 *    Resp:  { code, msg, data: { message_id, ... } }
 *    Permission: im:message:send_as_bot (app scope)
 *
 * 9. Contact users find_by_department (list DIRECT members of ONE department)
 *    SDK: types/index.d.ts line 36808-36900, `contact.user.findByDepartment`
 *         lib/index.js line ~22436 (runtime URL + method confirmed)
 *    Doc: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/find_by_department
 *    GET  /open-apis/contact/v3/users/find_by_department
 *    Query: department_id (required; "0" = root),
 *           department_id_type?, user_id_type?, page_size? (max 50),
 *           page_token? (pagination cursor)
 *    Resp:  { code, msg, data: { has_more?, page_token?, items?: [
 *             { open_id?, user_id?, name, en_name?, nickname?, email?,
 *               mobile, status?: { is_frozen?, is_resigned?, is_exited?, ... }, ... }
 *           ]}}
 *    IMPORTANT: This endpoint returns ONLY the DIRECT members of the
 *    specified department. It does NOT recurse into sub-departments.
 *    Calling it with department_id="0" returns only users that are
 *    directly under the root (usually a handful). To enumerate every
 *    employee in the tenant we must first walk the department tree
 *    with endpoint 10 below, then call find_by_department for each
 *    department id.
 *
 * 10. Contact departments/children (walk the department tree)
 *    SDK: types/index.d.ts `contact.department.children`
 *         lib/index.js runtime URL confirmed below
 *    Doc: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/department/children
 *    GET  /open-apis/contact/v3/departments/{department_id}/children
 *    Path:  department_id (required; "0" = root)
 *    Query: department_id_type?, user_id_type?,
 *           fetch_child?: boolean  ← CRITICAL: set true to recurse into
 *                                    the entire sub-tree in one response
 *           page_size?, page_token?
 *    Resp:  { code, msg, data: { has_more?, page_token?, items?: [
 *             { name, department_id, open_department_id,
 *               parent_department_id, leader_user_id?, status, ... }
 *           ]}}
 *    Permission: tenant_access_token + "全员通讯录" scope when starting
 *                from department_id="0".
 * ===========================================================================
 */
import {
  BusyInterval,
  CalendarProvider,
  CreateEventInput,
  CreatedEvent,
  DirectoryCandidate,
  ResolvedUser,
  UpcomingEvent,
} from "./types";

export interface LarkConfig {
  appId: string;
  appSecret: string;
  /** Calendar id to write events into. The app must own it or be a writer. */
  calendarId: string;
  /** Default host; override for Lark international or self-hosted. */
  baseUrl?: string;
}

interface TenantToken {
  token: string;
  expiresAt: number; // epoch ms
}

/**
 * One row from `find_by_department.data.items[]` that we actually care about
 * for name → open_id resolution. Field names mirror the SDK type at
 * types/index.d.ts line 36822-36830 exactly.
 */
interface DirectoryUser {
  open_id: string;
  user_id?: string;
  name: string;        // primary display name (Chinese for CN tenants)
  en_name?: string;
  nickname?: string;
  email?: string;
  mobile?: string;
}

const DIRECTORY_TTL_MS = 60 * 60 * 1000; // 60 min

export class LarkCalendarProvider implements CalendarProvider {
  private base: string;
  private tokenCache: TenantToken | null = null;
  private emailToOpenId = new Map<string, string>();

  /**
   * Cached snapshot of every user the bot can see in the tenant directory.
   * Populated lazily on first name lookup, refreshed when older than
   * DIRECTORY_TTL_MS, shared across all calls.
   *
   * Source: GET /open-apis/contact/v3/users/find_by_department
   *         (citation 9 at the top of this file)
   */
  private directoryUsers: DirectoryUser[] = [];
  private directoryFetchedAt = 0;
  /**
   * Inflight refresh promise. Multiple concurrent name lookups during a
   * cold cache should reuse a single HTTP fetch instead of stampeding the
   * Feishu API.
   */
  private directoryRefreshPromise: Promise<void> | null = null;

  constructor(private cfg: LarkConfig) {
    this.base = (cfg.baseUrl ?? "https://open.feishu.cn").replace(/\/$/, "");
  }

  // ---------------------------------------------------------------------------
  // Internal: fetch with a hard timeout via AbortController.
  //
  // Node 18+'s built-in fetch has NO default timeout. A misbehaving Feishu
  // endpoint, a stalled TCP connection, or DNS hanging on a virtual proxy
  // IP will cause `await fetch()` to block FOREVER, which in turn keeps
  // the OpenClaw tool execute() pending, which in turn blocks the LLM
  // turn until the agent's outer 60s timeout fires. Symptom: the user
  // sees nothing happen and the bot eventually goes silent.
  //
  // Wrapping every fetch in an AbortController + setTimeout makes the
  // failure mode visible (the call throws after `timeoutMs`, our caller
  // logs it, and the LLM gets a clean error result instead of a hang).
  // ---------------------------------------------------------------------------
  private async fetchWithTimeout(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const timeoutMs = init.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error(`Lark HTTP timeout after ${timeoutMs}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: obtain and cache a tenant_access_token.
  // Source: https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
  // ---------------------------------------------------------------------------
  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }
    const res = await this.fetchWithTimeout(
      `${this.base}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_id: this.cfg.appId,
          app_secret: this.cfg.appSecret,
        }),
        timeoutMs: 10000,
      },
    );
    const data: any = await res.json();
    if (data.code !== 0) {
      throw new Error(
        `Lark tenant_access_token failed: code=${data.code} msg=${data.msg}`,
      );
    }
    this.tokenCache = {
      token: data.tenant_access_token,
      // `expire` is seconds per the docs.
      expiresAt: now + data.expire * 1000,
    };
    return this.tokenCache.token;
  }

  // ---------------------------------------------------------------------------
  // Internal: authenticated HTTP helper. Returns the parsed JSON body and
  // throws on any non-zero `code` per Feishu's universal response envelope.
  //
  // All calls go through fetchWithTimeout (default 15s) so a stuck Feishu
  // endpoint can never freeze the plugin's tool execute() forever.
  // ---------------------------------------------------------------------------
  private async call<T = any>(
    path: string,
    init: { method?: string; query?: Record<string, string>; body?: any; timeoutMs?: number } = {},
  ): Promise<T> {
    const method = init.method ?? "GET";
    const t0 = Date.now();
    // eslint-disable-next-line no-console
    console.error(
      `[lark.http] → ${method} ${path}` +
        (init.query ? ` query=${JSON.stringify(init.query)}` : "") +
        (init.body !== undefined
          ? ` bodyKeys=${JSON.stringify(Object.keys(init.body ?? {}))}`
          : ""),
    );
    const token = await this.getToken();
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      url.searchParams.set(k, v);
    }
    let res: Response;
    try {
      res = await this.fetchWithTimeout(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        timeoutMs: init.timeoutMs ?? 15000,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[lark.http] ✗ ${method} ${path} network-error +${Date.now() - t0}ms: ${String(
          (err as any)?.message ?? err,
        )}`,
      );
      throw err;
    }
    const data: any = await res.json();
    if (data.code !== 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[lark.http] ✗ ${method} ${path} http=${res.status} +${Date.now() - t0}ms code=${
          data.code
        } msg=${data.msg ?? "unknown"}`,
      );
      throw new Error(
        `Lark API ${path} failed: code=${data.code} msg=${data.msg ?? "unknown"}`,
      );
    }
    // eslint-disable-next-line no-console
    console.error(
      `[lark.http] ← ${method} ${path} http=${res.status} +${Date.now() - t0}ms ok`,
    );
    return data as T;
  }

  // ---------------------------------------------------------------------------
  // Identity resolution.
  //
  // Source of supported inputs:
  //   1. Already-an-open_id -> passed through verbatim.
  //   2. Email / mobile     -> POST /open-apis/contact/v3/users/batch_get_id
  //      (https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id)
  //   3. Display name       -> GET /open-apis/contact/v3/users/find_by_department
  //      with department_id="0" pulls the entire tenant directory once,
  //      cached in memory for 60 minutes. We then match the input name
  //      against `name`, `en_name`, and `nickname` fields. See citation 9
  //      at the top of this file.
  // ---------------------------------------------------------------------------
  private classify(q: string): "open_id" | "email" | "phone" | "name" {
    if (q.startsWith("ou_") || q.startsWith("on_")) return "open_id";
    if (q.includes("@")) return "email";
    if (/^\+?\d{7,15}$/.test(q.replace(/[\s-]/g, ""))) return "phone";
    return "name";
  }

  // ---------------------------------------------------------------------------
  // Pull the entire tenant directory (or refresh the cache if expired).
  //
  // This walks the tenant in two stages, per citations (9) and (10) at the
  // top of this file:
  //
  //   Stage A: GET /contact/v3/departments/0/children?fetch_child=true
  //            Recursively lists every sub-department under the root in
  //            one paginated call. We collect every department_id into a
  //            set (plus "0" itself for the root's direct members).
  //
  //   Stage B: For EACH department id, GET /contact/v3/users/find_by_department
  //            which returns the DIRECT members of that one department.
  //            We merge + de-duplicate by open_id (a user can be primary
  //            in one department and cross-listed in others).
  //
  // Why not just `find_by_department` with department_id="0"?
  //   Because that endpoint is direct-members-only — it does NOT recurse.
  //   With department_id="0" it returns ONLY the handful of employees who
  //   are directly attached to the root (usually 0-2). Every real employee
  //   belongs to a sub-department and would be invisible.
  //
  // Both stages paginate. We cap each at 200 pages for safety.
  // ---------------------------------------------------------------------------
  async listAllUsers(): Promise<DirectoryUser[]> {
    const now = Date.now();
    if (
      this.directoryUsers.length > 0 &&
      now - this.directoryFetchedAt < DIRECTORY_TTL_MS
    ) {
      return this.directoryUsers;
    }
    if (this.directoryRefreshPromise) {
      await this.directoryRefreshPromise;
      return this.directoryUsers;
    }
    this.directoryRefreshPromise = (async () => {
      // --- Stage A: walk the department tree ------------------------------
      //
      // Always include "0" so we pick up direct members of the root dept
      // alongside the recursively-discovered sub-departments.
      const departmentIds = new Set<string>(["0"]);
      let deptPageToken: string | undefined;
      const MAX_PAGES = 200;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query: Record<string, string> = {
          department_id_type: "department_id",
          fetch_child: "true",
          page_size: "50",
        };
        if (deptPageToken) query.page_token = deptPageToken;
        const data = await this.call<any>(
          `/open-apis/contact/v3/departments/${encodeURIComponent("0")}/children`,
          { method: "GET", query },
        );
        const items: any[] = data?.data?.items ?? [];
        for (const d of items) {
          // The SDK types expose `department_id` as the primary key for
          // sub-requests when department_id_type is "department_id".
          const depId =
            typeof d?.department_id === "string" ? d.department_id : undefined;
          if (depId) departmentIds.add(depId);
        }
        if (!data?.data?.has_more || !data?.data?.page_token) break;
        deptPageToken = data.data.page_token;
      }
      // eslint-disable-next-line no-console
      console.error(
        `[lark] directory walk: discovered ${departmentIds.size} departments (incl. root)`,
      );

      // --- Stage B: pull members of each department, dedupe by open_id ---
      const byOpenId = new Map<string, DirectoryUser>();
      let skippedFrozen = 0;
      for (const depId of departmentIds) {
        let userPageToken: string | undefined;
        let deptMembers = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
          const query: Record<string, string> = {
            department_id: depId,
            department_id_type: "department_id",
            user_id_type: "open_id",
            page_size: "50",
          };
          if (userPageToken) query.page_token = userPageToken;
          let data: any;
          try {
            data = await this.call<any>(
              "/open-apis/contact/v3/users/find_by_department",
              { method: "GET", query },
            );
          } catch (err) {
            // One department failing (e.g. permission scope mid-tree)
            // shouldn't abort the whole walk.
            // eslint-disable-next-line no-console
            console.error(
              `[lark] find_by_department(${depId}) failed: ${String(
                (err as any)?.message ?? err,
              )}`,
            );
            break;
          }
          const items: any[] = data?.data?.items ?? [];
          for (const u of items) {
            if (!u?.open_id) continue;
            const status = u.status ?? {};
            if (status.is_frozen || status.is_resigned || status.is_exited) {
              skippedFrozen++;
              // eslint-disable-next-line no-console
              console.error(
                `[lark.walk] skip inactive user name="${u.name ?? ""}" open_id=${
                  u.open_id
                } frozen=${!!status.is_frozen} resigned=${!!status.is_resigned} exited=${!!status.is_exited}`,
              );
              continue;
            }
            if (!byOpenId.has(u.open_id)) {
              byOpenId.set(u.open_id, {
                open_id: u.open_id,
                user_id: u.user_id,
                name: typeof u.name === "string" ? u.name : "",
                en_name: u.en_name,
                nickname: u.nickname,
                email: u.email,
                mobile: u.mobile,
              });
              deptMembers++;
            }
          }
          if (!data?.data?.has_more || !data?.data?.page_token) break;
          userPageToken = data.data.page_token;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[lark.walk] dept=${depId} added ${deptMembers} new members`,
        );
      }

      this.directoryUsers = Array.from(byOpenId.values());
      this.directoryFetchedAt = Date.now();
      // eslint-disable-next-line no-console
      console.error(
        `[lark] directory walk: collected ${this.directoryUsers.length} unique active users across ${departmentIds.size} departments (skipped ${skippedFrozen} inactive)`,
      );
      // Dump each user so operators can grep by name and confirm the
      // directory actually contains the person they expect. Without this,
      // when "安子岩" is unresolved we can't tell whether it's a directory
      // gap, a name mismatch, or an LLM hallucination.
      for (const u of this.directoryUsers) {
        // eslint-disable-next-line no-console
        console.error(
          `[lark.walk]   user name="${u.name}"${
            u.en_name ? ` en="${u.en_name}"` : ""
          }${u.nickname ? ` nick="${u.nickname}"` : ""}${
            u.email ? ` email=${u.email}` : ""
          } open_id=${u.open_id}`,
        );
      }
    })();
    try {
      await this.directoryRefreshPromise;
    } finally {
      this.directoryRefreshPromise = null;
    }
    return this.directoryUsers;
  }

  /**
   * Snapshot the whole directory as DirectoryCandidate[]. No filtering,
   * no scoring, no matching — the caller (the LLM, via the tool result)
   * does the semantic pick. This file used to implement exact + substring
   * matching here, which was architecturally wrong: display names in a
   * real tenant are noisy (suffixes, nicknames, team tags, typos) and the
   * LLM is far better at "which one is 安子岩" than any string heuristic.
   */
  private directorySnapshotAsCandidates(
    directory: DirectoryUser[],
  ): DirectoryCandidate[] {
    return directory.map((u) => ({
      userId: u.open_id,
      name: u.name,
      en_name: u.en_name,
      nickname: u.nickname,
      email: u.email,
    }));
  }

  async resolveUsers(queries: string[]): Promise<ResolvedUser[]> {
    const t0 = Date.now();
    // eslint-disable-next-line no-console
    console.error(
      `[lark.resolve] start queries=${JSON.stringify(queries)} (${queries.length})`,
    );
    const out: ResolvedUser[] = new Array(queries.length);
    const emailIdx: number[] = [];
    const phoneIdx: number[] = [];
    const nameIdx: number[] = [];

    queries.forEach((q, i) => {
      const via = this.classify(q);
      // eslint-disable-next-line no-console
      console.error(`[lark.resolve] classify "${q}" → ${via}`);
      if (via === "open_id") {
        out[i] = { query: q, userId: q, via: "open_id" };
      } else if (via === "email") {
        const cached = this.emailToOpenId.get(q);
        if (cached) {
          // eslint-disable-next-line no-console
          console.error(`[lark.resolve] email cache hit "${q}" → ${cached}`);
          out[i] = { query: q, userId: cached, via: "email" };
        } else {
          emailIdx.push(i);
        }
      } else if (via === "phone") {
        phoneIdx.push(i);
      } else {
        // via === "name" — defer to a single directory fetch below
        nameIdx.push(i);
      }
    });

    // -------------------------------------------------------------------------
    // Batch resolve emails.
    // Source: https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id
    //   POST /open-apis/contact/v3/users/batch_get_id?user_id_type=open_id
    //   Body: { emails: string[] }  (max 50)
    //   Response data.user_list[] items: { user_id, email, mobile, status }
    // -------------------------------------------------------------------------
    if (emailIdx.length > 0) {
      try {
        const data = await this.call<any>(
          "/open-apis/contact/v3/users/batch_get_id",
          {
            method: "POST",
            query: { user_id_type: "open_id" },
            body: { emails: emailIdx.map((i) => queries[i]) },
          },
        );
        const map = new Map<string, string>();
        for (const u of data.data?.user_list ?? []) {
          if (u.email && u.user_id) {
            map.set(u.email, u.user_id);
            this.emailToOpenId.set(u.email, u.user_id);
          }
        }
        for (const i of emailIdx) {
          const id = map.get(queries[i]);
          out[i] = id
            ? { query: queries[i], userId: id, via: "email" }
            : { query: queries[i], userId: "", via: "unresolved" };
        }
      } catch {
        for (const i of emailIdx) {
          out[i] = { query: queries[i], userId: "", via: "unresolved" };
        }
      }
    }

    // -------------------------------------------------------------------------
    // Batch resolve mobiles.
    // Same endpoint as emails, swap the body to { mobiles: [...] }.
    // -------------------------------------------------------------------------
    if (phoneIdx.length > 0) {
      try {
        const data = await this.call<any>(
          "/open-apis/contact/v3/users/batch_get_id",
          {
            method: "POST",
            query: { user_id_type: "open_id" },
            body: {
              mobiles: phoneIdx.map((i) =>
                queries[i].replace(/[\s-]/g, ""),
              ),
            },
          },
        );
        const map = new Map<string, string>();
        for (const u of data.data?.user_list ?? []) {
          if (u.mobile && u.user_id) map.set(u.mobile, u.user_id);
        }
        for (const i of phoneIdx) {
          const id = map.get(queries[i].replace(/[\s-]/g, ""));
          out[i] = id
            ? { query: queries[i], userId: id, via: "phone" }
            : { query: queries[i], userId: "", via: "unresolved" };
        }
      } catch {
        for (const i of phoneIdx) {
          out[i] = { query: queries[i], userId: "", via: "unresolved" };
        }
      }
    }

    // -------------------------------------------------------------------------
    // Name queries: we pull the full tenant directory and hand it back to
    // the caller as `candidates`. The plugin intentionally does NO matching —
    // string-based name matching is hopeless on real directories (suffixes,
    // nicknames, team tags). The LLM is far better at picking the right
    // "安子岩" from a list than any heuristic we could write here.
    //
    // Source: GET /open-apis/contact/v3/users/find_by_department  (citation 9)
    // -------------------------------------------------------------------------
    if (nameIdx.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[lark.resolve] name-queries count=${nameIdx.length} list=${JSON.stringify(
          nameIdx.map((i) => queries[i]),
        )} → fetching tenant directory`,
      );
      let directory: DirectoryUser[] = [];
      try {
        directory = await this.listAllUsers();
      } catch (err) {
        for (const i of nameIdx) {
          out[i] = { query: queries[i], userId: "", via: "unresolved" };
        }
        // eslint-disable-next-line no-console
        console.error(
          `[lark] listAllUsers failed: ${String((err as any)?.message ?? err)}`,
        );
        return out;
      }

      const candidates = this.directorySnapshotAsCandidates(directory);
      // eslint-disable-next-line no-console
      console.error(
        `[lark.resolve] directory size=${candidates.length}; returning full candidates list for LLM to pick from`,
      );
      // For diagnostic purposes: if ANY of the requested names literally
      // appears in the directory as an exact substring of name/en_name/nickname,
      // log it. We still leave the actual match decision to the LLM, but
      // this lets operators see at a glance whether the target is in the
      // directory at all.
      for (const i of nameIdx) {
        const q = queries[i];
        const hits = directory.filter(
          (u) =>
            (u.name && u.name.includes(q)) ||
            (u.en_name && u.en_name.includes(q)) ||
            (u.nickname && u.nickname.includes(q)),
        );
        // eslint-disable-next-line no-console
        console.error(
          `[lark.resolve]   "${q}" diagnostic substring matches in directory: ${
            hits.length
          }${
            hits.length > 0
              ? " → " +
                hits
                  .map((h) => `${h.name}(${h.open_id})`)
                  .slice(0, 5)
                  .join(", ")
              : ""
          }`,
        );
      }
      for (const i of nameIdx) {
        out[i] = {
          query: queries[i],
          userId: "",
          via: "unresolved",
          candidates,
        };
      }
    }

    // eslint-disable-next-line no-console
    console.error(
      `[lark.resolve] done +${Date.now() - t0}ms → ` +
        out
          .map(
            (r) =>
              `${r.query}→${
                r.userId ? r.userId : "UNRESOLVED"
              }(${r.via})`,
          )
          .join(" | "),
    );
    return out;
  }

  /** Convenience: drop unresolved, return plain open_id array. */
  private async resolveOpenIds(attendees: string[]): Promise<string[]> {
    const resolved = await this.resolveUsers(attendees);
    return resolved.filter((r) => r.userId).map((r) => r.userId);
  }

  // ---------------------------------------------------------------------------
  // Free/busy query.
  // Source: https://open.feishu.cn/document/server-docs/calendar-v4/free_busy/list
  //   POST /open-apis/calendar/v4/freebusy/list?user_id_type=open_id
  //   Body: { time_min, time_max, user_id }
  //     time_min / time_max are RFC3339 (e.g. "2020-10-28T12:00:00+08:00").
  //     user_id and room_id are mutually exclusive; we only query users here.
  //   Response: data.freebusy_list[] items have { start_time, end_time, rsvp_status }.
  //
  // The API takes ONE user per request, so we issue one call per attendee.
  // ---------------------------------------------------------------------------
  async freeBusy(
    emailsOrOpenIds: string[],
    from: Date,
    to: Date,
  ): Promise<Record<string, BusyInterval[]>> {
    const openIds = await this.resolveOpenIds(emailsOrOpenIds);

    const out: Record<string, BusyInterval[]> = {};
    for (let i = 0; i < openIds.length; i++) {
      const data = await this.call<any>(
        "/open-apis/calendar/v4/freebusy/list",
        {
          method: "POST",
          query: { user_id_type: "open_id" },
          body: {
            time_min: from.toISOString(),
            time_max: to.toISOString(),
            user_id: openIds[i],
          },
        },
      );
      const intervals: BusyInterval[] = (data.data?.freebusy_list ?? []).map(
        (b: any) => ({
          start: new Date(b.start_time),
          end: new Date(b.end_time),
        }),
      );
      out[emailsOrOpenIds[i]] = intervals;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Create a calendar event (+ add attendees in a second call).
  //
  // Endpoint + shape sources: see citation block (3) and (4) at the top of
  // this file. All field names, types, and enum values below are verified
  // against @larksuiteoapi/node-sdk/types/index.d.ts.
  //
  // IDEMPOTENCY KEY
  // ---------------
  // SDK line 28055-28057 exposes `params.idempotency_key` on the create
  // payload. Feishu's server deduplicates concurrent/retry requests that
  // carry the same key and returns the existing event_id instead of
  // creating a duplicate. This is the ONLY safe way to handle the case
  // where the LLM agent loop retries the tool call after a timeout or a
  // momentary error.
  //
  // We derive the key deterministically from the (calendar, title, start,
  // end, sorted attendees) tuple. Same inputs -> same key -> same event.
  // Different duration or attendees -> different key -> new event.
  // ---------------------------------------------------------------------------
  async createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    const startUnix = Math.floor(input.start.getTime() / 1000);
    const endUnix = Math.floor(input.end.getTime() / 1000);

    const idempotencyKey = await computeIdempotencyKey({
      calendarId: this.cfg.calendarId,
      title: input.title,
      startUnix,
      endUnix,
      attendees: [...(input.attendees ?? [])].sort(),
    });

    const created = await this.call<any>(
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(
        this.cfg.calendarId,
      )}/events`,
      {
        method: "POST",
        query: { idempotency_key: idempotencyKey },
        body: {
          summary: input.title,
          description: input.description ?? "",
          need_notification: true,
          start_time: {
            timestamp: String(startUnix),
            timezone: input.timezone,
          },
          end_time: {
            timestamp: String(endUnix),
            timezone: input.timezone,
          },
        },
      },
    );

    const eventId = created.data?.event?.event_id;
    if (!eventId) throw new Error("Lark createEvent: no event_id returned");

    // Add attendees in a second call (endpoint 4 in the citation block).
    const openIds = await this.resolveOpenIds(input.attendees);
    if (openIds.length > 0) {
      await this.call(
        `/open-apis/calendar/v4/calendars/${encodeURIComponent(
          this.cfg.calendarId,
        )}/events/${eventId}/attendees`,
        {
          method: "POST",
          query: { user_id_type: "open_id" },
          body: {
            attendees: openIds.map((id) => ({ type: "user" as const, user_id: id })),
            need_notification: true,
          },
        },
      );
    }

    return {
      id: eventId,
      htmlLink: undefined,
      joinUrl: created.data?.event?.vchat?.meeting_url ?? undefined,
      start: input.start,
      end: input.end,
    };
  }

  // ---------------------------------------------------------------------------
  // List upcoming events on the configured calendar.
  // Source: https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/list
  //   GET /open-apis/calendar/v4/calendars/{calendar_id}/events
  //   Query: start_time / end_time (unix seconds as strings)
  // ---------------------------------------------------------------------------
  async listUpcoming(_email: string, hours: number): Promise<UpcomingEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const max = now + hours * 3600;
    const data = await this.call<any>(
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(
        this.cfg.calendarId,
      )}/events`,
      {
        method: "GET",
        query: { start_time: String(now), end_time: String(max) },
      },
    );
    return (data.data?.items ?? []).map((e: any) => ({
      id: e.event_id,
      title: e.summary ?? "(no title)",
      start: new Date(Number(e.start_time?.timestamp ?? 0) * 1000),
      end: new Date(Number(e.end_time?.timestamp ?? 0) * 1000),
      attendees: [],
    }));
  }

  // ---------------------------------------------------------------------------
  // Delete a calendar event.
  // Source: https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/delete
  //   DELETE /open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}
  // ---------------------------------------------------------------------------
  async cancelEvent(eventId: string): Promise<void> {
    await this.call(
      `/open-apis/calendar/v4/calendars/${encodeURIComponent(
        this.cfg.calendarId,
      )}/events/${eventId}`,
      { method: "DELETE" },
    );
  }

  // ---------------------------------------------------------------------------
  // Send a plain-text direct message from the bot to a user.
  //
  // Source: citation (8) at the top of this file.
  //   POST /open-apis/im/v1/messages?receive_id_type=open_id
  //   Body: { receive_id, msg_type: "text", content: JSON.stringify({text}) }
  //
  // `content` MUST be a JSON string, not an object — this is the single
  // biggest trap in the Feishu IM API. For `msg_type: "text"` the schema
  // per the open-platform docs is `{ "text": "..." }`, which we stringify.
  //
  // `uuid` is optional; Feishu dedupes messages with the same uuid sent
  // within 1 hour. We pass a random one so retries after network errors
  // don't silently duplicate.
  // ---------------------------------------------------------------------------
  async sendTextDM(openId: string, text: string): Promise<string> {
    // eslint-disable-next-line no-console
    console.error(
      `[lark.dm] → sending DM to ${openId} textLen=${text.length} preview="${text
        .slice(0, 60)
        .replace(/\n/g, "\\n")}${text.length > 60 ? "…" : ""}"`,
    );
    try {
      const data = await this.call<any>("/open-apis/im/v1/messages", {
        method: "POST",
        query: { receive_id_type: "open_id" },
        body: {
          receive_id: openId,
          msg_type: "text",
          content: JSON.stringify({ text }),
          uuid: randomUuid(),
        },
      });
      const messageId = data?.data?.message_id ?? "";
      // eslint-disable-next-line no-console
      console.error(
        `[lark.dm] ✓ DM delivered to ${openId} messageId=${messageId}`,
      );
      return messageId;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[lark.dm] ✗ DM to ${openId} failed: ${String(
          (err as any)?.message ?? err,
        )}`,
      );
      throw err;
    }
  }
}

// --- helpers -----------------------------------------------------------------

function randomUuid(): string {
  // Small RFC4122-ish random id. Good enough for Feishu's 1h dedup window.
  // Avoids pulling in a crypto dep just for this.
  const rnd = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${rnd()}${rnd()}-${rnd()}-${rnd()}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}

// ---------------------------------------------------------------------------
// Deterministic idempotency key.
//
// Feeds the (calendar, title, start, end, sorted-attendees) tuple into
// SHA-256 and returns the first 32 hex chars. Node ≥16 has webcrypto on
// `crypto.subtle` and also a CommonJS `crypto.createHash`. We use the
// sync createHash form since this is called from an async function anyway.
// ---------------------------------------------------------------------------
async function computeIdempotencyKey(input: {
  calendarId: string;
  title: string;
  startUnix: number;
  endUnix: number;
  attendees: string[];
}): Promise<string> {
  const payload = JSON.stringify({
    c: input.calendarId,
    t: input.title,
    s: input.startUnix,
    e: input.endUnix,
    a: input.attendees,
  });
  // Lazy import to keep the top of the file free of node-only requires.
  const { createHash } = await import("crypto");
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}
