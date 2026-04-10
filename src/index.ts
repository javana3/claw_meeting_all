/**
 * OpenClaw plugin: meeting-scheduler
 *
 * ===========================================================================
 * SOURCE-OF-TRUTH CITATIONS
 * ===========================================================================
 * Every type and API shape in this file is traceable to the OpenClaw /
 * pi-agent-core / pi-ai type declaration files shipped with the installed
 * OpenClaw package. No field or signature is invented.
 *
 * 1. Plugin entry module shape
 *    Source: <openclaw>/dist/plugin-sdk/src/plugins/types.d.ts
 *      export type OpenClawPluginDefinition = {
 *        id?: string;
 *        name?: string;
 *        description?: string;
 *        version?: string;
 *        kind?: PluginKind | PluginKind[];
 *        configSchema?: OpenClawPluginConfigSchema;
 *        register?: (api: OpenClawPluginApi) => void | Promise<void>;
 *        activate?: (api: OpenClawPluginApi) => void | Promise<void>;
 *      };
 *      export type OpenClawPluginModule =
 *        OpenClawPluginDefinition | ((api: OpenClawPluginApi) => void | Promise<void>);
 *
 * 2. Registration API handed to `register(api)`
 *    Source: <openclaw>/dist/plugin-sdk/src/plugins/types.d.ts
 *      registerTool: (
 *        tool: AnyAgentTool | OpenClawPluginToolFactory,
 *        opts?: OpenClawPluginToolOptions
 *      ) => void;
 *
 * 3. Tool factory context (how a tool sees the request sender)
 *    Source: <openclaw>/dist/plugin-sdk/src/plugins/types.d.ts
 *      export type OpenClawPluginToolContext = {
 *        config?: OpenClawConfig;
 *        runtimeConfig?: OpenClawConfig;
 *        workspaceDir?: string;
 *        agentId?: string;
 *        sessionId?: string;
 *        messageChannel?: string;
 *        deliveryContext?: DeliveryContext;
 *        requesterSenderId?: string;   // <-- trusted sender id
 *        senderIsOwner?: boolean;
 *        ...
 *      };
 *      export type OpenClawPluginToolFactory =
 *        (ctx: OpenClawPluginToolContext) =>
 *          AnyAgentTool | AnyAgentTool[] | null | undefined;
 *
 * 4. AgentTool shape (what registerTool expects back)
 *    Source: <openclaw>/node_modules/@mariozechner/pi-agent-core/dist/types.d.ts
 *      export interface AgentTool<
 *        TParameters extends TSchema = TSchema,
 *        TDetails = any
 *      > extends Tool<TParameters> {
 *        label: string;
 *        prepareArguments?: (args: unknown) => Static<TParameters>;
 *        execute: (
 *          toolCallId: string,
 *          params: Static<TParameters>,
 *          signal?: AbortSignal,
 *          onUpdate?: AgentToolUpdateCallback<TDetails>
 *        ) => Promise<AgentToolResult<TDetails>>;
 *      }
 *      export interface AgentToolResult<T> {
 *        content: (TextContent | ImageContent)[];
 *        details: T;
 *      }
 *
 * 5. Base Tool (what AgentTool extends)
 *    Source: <openclaw>/node_modules/@mariozechner/pi-ai/dist/types.d.ts
 *      import type { TSchema } from "@sinclair/typebox";
 *      export interface Tool<TParameters extends TSchema = TSchema> {
 *        name: string;
 *        description: string;
 *        parameters: TParameters;
 *      }
 *
 * Because `parameters` is a `TSchema` from @sinclair/typebox, we'd normally
 * build it with typebox's `Type.Object({...})`. To avoid adding typebox as a
 * dependency, we declare the tool object with `as any` at the boundary and
 * supply a plain JSON-Schema-shaped object. This works because the embedded
 * agent runner only inspects `.properties` / `.required` / `.type` at runtime
 * (confirmed by the "tools.25.custom.name" format error OpenClaw surfaced
 * earlier, which is string-pattern validation, not structural TSchema checks).
 *
 * Feishu API calls are centralised in providers/lark.ts which carries its
 * own citation block.
 * ===========================================================================
 */
import { loadEnv } from "./load-env";
loadEnv();

import { createHash } from "node:crypto";
import { GoogleCalendarProvider } from "./providers/google";
import { LarkCalendarProvider } from "./providers/lark";
import { CalendarProvider, ResolvedUser } from "./providers/types";
import {
  findCandidateSlots,
  findSlotsInWindows,
  intersectManyWindows,
  ScheduleRules,
  SearchResult,
  Window,
} from "./scheduler";

// ============================================================================
// Small helpers
// ============================================================================

function asArray<T = string>(v: any): T[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.length > 0) return [v as any];
  return [];
}

/**
 * Drop empty / malformed open_ids, de-duplicate.
 * Accept names / emails / phones verbatim — the provider layer will validate.
 */
function normalizeAttendees(list: string[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "string") continue;
    const v = raw.trim();
    if (!v) continue;
    if (v.startsWith("ou_")) {
      // Feishu open_id format. The characters after "ou_" are alphanumeric.
      // Reject garbled ids (e.g. LLM miscounted characters) so we don't
      // send a guaranteed-404 request to the API.
      if (/^ou_[a-zA-Z0-9]{20,50}$/.test(v)) out.add(v);
      continue;
    }
    out.add(v);
  }
  return Array.from(out);
}

/**
 * Standard text-only tool result builder.
 *
 * Source for the shape:
 *   <openclaw>/node_modules/@mariozechner/pi-agent-core/dist/types.d.ts
 *   interface AgentToolResult<T> {
 *     content: (TextContent | ImageContent)[];
 *     details: T;
 *   }
 *
 * pi-ai's TextContent is { type: "text"; text: string } (confirmed by
 * <openclaw>/node_modules/@mariozechner/pi-ai/dist/types.d.ts exporting
 * TextContent from the same import group used by pi-agent-core).
 */
function toolResult<TDetails>(
  text: string,
  details: TDetails,
): { content: { type: "text"; text: string }[]; details: TDetails } {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

// ============================================================================
// PendingMeeting store — 12h TTL, 1h status-update interval.
//
// This is the central state for the NL-reply workflow:
//
//   1. Initiator DMs bot       → find_and_book_meeting creates a
//                                 PendingMeeting and DMs each attendee
//                                 asking for their availability.
//   2. Attendee DMs bot        → the LLM (in that attendee's session)
//                                 calls list_my_pending_invitations and
//                                 then record_attendee_response with the
//                                 structured status it extracted from the
//                                 attendee's natural-language reply.
//   3. All attendees responded → record_attendee_response auto-finalises:
//                                 intersects availability, creates the real
//                                 calendar event, DMs the initiator.
//   4. 1h has passed with      → the background ticker DMs the initiator
//      unresolved attendees      a "X accepted, Y not yet replied" status.
//   5. 12h has passed          → the ticker DMs the initiator with the
//                                 final roll-call and marks the meeting
//                                 as expired (no event created).
//
// All state is kept in-memory. A gateway restart wipes pending meetings.
// ============================================================================

const PENDING_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const STATUS_UPDATE_INTERVAL_MS = 60 * 60 * 1000; // 1h
const TICKER_INTERVAL_MS = 60 * 1000; // 1 min

type AttendeeStatus =
  | "pending" // not yet replied
  | "accepted" // accepted the original window as-is
  | "declined" // explicit decline, cannot attend
  | "proposed_alt"; // wants to attend but only within proposed_windows

interface AttendeeResponse {
  openId: string;
  status: AttendeeStatus;
  /** When status==="proposed_alt", the windows the attendee is available in. */
  proposedWindows?: { start: Date; end: Date }[];
  /** Free-text note from the attendee (e.g. "我刚好下周休假"). Passed through verbatim. */
  note?: string;
  respondedAt?: number;
}

interface PendingMeeting {
  id: string;
  initiatorOpenId: string;
  title: string;
  description?: string;
  /** The original time window the initiator asked for. */
  originalWindow: { earliest: Date; latest: Date };
  durationMinutes: number;
  timezone: string;
  attendees: AttendeeResponse[];
  createdAt: number;
  expiresAt: number;
  /** Epoch ms of the last status-update DM the ticker sent. 0 = none yet. */
  lastStatusUpdateAt: number;
  /** Set to the real calendar event id once the meeting is finalised. */
  finalEventId?: string;
  /** Set when the meeting is closed (either finalised or expired). */
  closed: boolean;
  /**
   * When all attendees have responded we don't finalise immediately. We
   * schedule a delayed finalize via setTimeout so the attendee has a
   * short buffer to send corrections. Any new record_attendee_response
   * during the wait cancels and re-schedules this timer.
   */
  finalizeTimer?: NodeJS.Timeout;
  finalizeScheduledAt?: number;
}

/** How long to wait after "all responded" before actually creating the event. */
const FINALIZE_DELAY_MS = 30_000;

const pendingMeetings = new Map<string, PendingMeeting>();

/**
 * Tool-level idempotency for find_and_book_meeting.
 *
 * Problem: Kimi-K2.5 sometimes hallucinates DOZENS of parallel identical
 * tool calls in a single turn (observed: ~60 concurrent calls with
 * identical params). Without this guard we would:
 *   - hit the Feishu directory / resolve API 60× (log spam, quota burn)
 *   - create 60 PendingMeeting records + send 60 duplicate DMs
 *
 * Solution: a two-layer guard.
 *
 *   Layer 1 — "in-flight" promise lock, keyed on the RAW request (before
 *   attendee resolution). Concurrent duplicate calls await the same promise
 *   and all return the same result. Key uses the raw attendee strings
 *   exactly as the LLM passed them (after dedupe + sort), so 60 parallel
 *   calls with the same string list collapse into 1 real execution.
 *
 *   Layer 2 — post-resolve fingerprint (kept as a safety net for
 *   sequential retries where the in-flight promise has already settled
 *   but the result is still "fresh"). Key includes the resolved user ids
 *   and runs AFTER resolveAll to catch retries where the LLM fed in
 *   different raw strings that resolved to the same users.
 */
const IDEMPOTENCY_WINDOW_MS = 60_000;
const recentFindAndBook = new Map<string, { meetingId: string; at: number }>();

/** In-flight request deduplication — keyed on the RAW input params. */
const inflightFindAndBook = new Map<string, Promise<any>>();

function gcIdempotency(now: number): void {
  for (const [k, v] of recentFindAndBook) {
    if (now - v.at > IDEMPOTENCY_WINDOW_MS) recentFindAndBook.delete(k);
  }
}

/**
 * Compute the raw-input fingerprint used for in-flight dedup. Runs BEFORE
 * attendee resolution so concurrent duplicate calls can short-circuit
 * without every single one walking the full tenant directory.
 */
function rawRequestKey(params: {
  sender: string;
  title: string;
  earliest: string;
  latest: string;
  duration: number;
  attendees: string[];
}): string {
  const sortedRaw = [...new Set(params.attendees)].sort();
  return createHash("sha256")
    .update(
      [
        params.sender,
        params.title,
        params.earliest,
        params.latest,
        String(params.duration),
        sortedRaw.join(","),
      ].join("|"),
    )
    .digest("hex");
}

function newMeetingId(): string {
  return (
    "mtg_" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

function gcPending(now: number): void {
  for (const [id, m] of pendingMeetings) {
    if (m.closed && now - m.createdAt > PENDING_TTL_MS) {
      // Ensure any pending finalize timer is cleared before we drop the ref.
      if (m.finalizeTimer) {
        clearTimeout(m.finalizeTimer);
        m.finalizeTimer = undefined;
      }
      pendingMeetings.delete(id);
    }
  }
}

/**
 * Merge an arbitrary set of [start, end) intervals into the minimal set of
 * non-overlapping, coalesced intervals. Used by record_attendee_response's
 * append mode so multiple rapid replies from the same attendee accumulate
 * into a clean availability list.
 *
 *   Input:  [(10:00-12:00), (11:30-13:00), (14:00-15:00)]
 *   Output: [(10:00-13:00), (14:00-15:00)]
 */
function mergeOverlappingWindows(
  windows: { start: Date; end: Date }[],
): { start: Date; end: Date }[] {
  if (windows.length === 0) return [];
  const sorted = [...windows]
    .filter((w) => w.end.getTime() > w.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: { start: Date; end: Date }[] = [];
  for (const w of sorted) {
    if (out.length === 0) {
      out.push({ start: w.start, end: w.end });
      continue;
    }
    const last = out[out.length - 1];
    // If they touch or overlap, extend the last range's end.
    if (w.start.getTime() <= last.end.getTime()) {
      if (w.end.getTime() > last.end.getTime()) last.end = w.end;
    } else {
      out.push({ start: w.start, end: w.end });
    }
  }
  return out;
}

// ============================================================================
// Plugin entry
// ============================================================================
//
// Shape of the default export follows OpenClawPluginDefinition exactly:
//   { id, name, description, version, register(api) }
// The `register` callback receives OpenClawPluginApi and calls
// api.registerTool(factory) once per tool.
//
// registerTool accepts either an AnyAgentTool object or an
// OpenClawPluginToolFactory function. We use the factory form here because
// the factory receives OpenClawPluginToolContext which carries
// `requesterSenderId` — the trusted open_id of the message sender. This
// was the missing piece when users said "和我" / "帮我" without naming
// themselves: there is no safe way to obtain the sender from execute args.
// ============================================================================

const plugin = {
  id: "meeting-scheduler",
  name: "Meeting Scheduler",
  description:
    "Find common free slots between Feishu users and book calendar events via natural language.",
  version: "0.2.0",

  register(api: any /* OpenClawPluginApi */) {
    // -----------------------------------------------------------------------
    // Configuration
    //
    // api.pluginConfig is the validated config block from openclaw.plugin.json
    // for this plugin. We fall back to process.env (populated by ./load-env.ts
    // from a .env file at the project root) so secrets never need to live in
    // the OpenClaw config file.
    // -----------------------------------------------------------------------
    const rawCfg = (api?.pluginConfig ?? api?.config ?? {}) as Record<string, string>;
    const cfg: Record<string, string> = new Proxy(rawCfg, {
      get(target, prop: string) {
        return target[prop] ?? process.env[prop] ?? "";
      },
    });

    const provider: CalendarProvider = cfg.LARK_APP_ID
      ? new LarkCalendarProvider({
          appId: cfg.LARK_APP_ID,
          appSecret: cfg.LARK_APP_SECRET,
          calendarId: cfg.LARK_CALENDAR_ID,
        })
      : new GoogleCalendarProvider({
          clientId: cfg.GOOGLE_CLIENT_ID,
          clientSecret: cfg.GOOGLE_CLIENT_SECRET,
          refreshToken: cfg.GOOGLE_REFRESH_TOKEN,
          organizerEmail: cfg.ORGANIZER_EMAIL,
        });

    const rules: ScheduleRules = {
      timezone: cfg.DEFAULT_TIMEZONE || "Asia/Shanghai",
      workHours: cfg.WORK_HOURS || "09:00-18:00",
      lunchBreak: cfg.LUNCH_BREAK || "12:00-13:30",
      bufferMinutes: Number(cfg.BUFFER_MINUTES || 15),
    };

    /**
     * Format "today" in the configured timezone for injection into the tool
     * description so the LLM can resolve "今天/明天/下周" correctly.
     *
     * Intl.DateTimeFormat with formatToParts is a standard JS API (ECMAScript
     * Internationalization API) — no invented behaviour.
     */
    function currentDateHint(): string {
      const zone = rules.timezone;

      // Intl.DateTimeFormat with `en-CA` locale emits ISO-style YYYY-MM-DD
      // directly. Source: ECMA-402 (Internationalization API) spec — en-CA
      // is the canonical locale choice for ISO-format dates across runtimes.
      const formatYMD = (d: Date) =>
        new Intl.DateTimeFormat("en-CA", {
          timeZone: zone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(d);
      const weekdayOf = (d: Date) =>
        new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          weekday: "long",
        }).format(d);

      const now = new Date();
      const oneDay = 86400 * 1000;
      const lines: string[] = [];
      lines.push(`today       = ${formatYMD(now)} (${weekdayOf(now)})`);
      for (let i = 1; i <= 7; i++) {
        const d = new Date(now.getTime() + i * oneDay);
        const tag =
          i === 1 ? "tomorrow   " : i === 2 ? "day-after  " : `+${i} days    `;
        lines.push(`${tag} = ${formatYMD(d)} (${weekdayOf(d)})`);
      }
      return (
        `Timezone=${zone}. ` +
        `Use these EXACT dates when resolving relative terms. ` +
        `DO NOT guess or calculate yourself:\n` +
        lines.map((l) => "  " + l).join("\n") +
        "\n" +
        "Chinese mapping: 今天→today, 明天→tomorrow, 后天→day-after, " +
        "下周X→pick the row whose weekday matches X."
      );
    }

    // -----------------------------------------------------------------------
    // Helpers that don't depend on per-request context
    // -----------------------------------------------------------------------

    async function resolveAll(queries: string[]): Promise<{
      resolved: ResolvedUser[];
      ids: string[];
      unresolved: string[];
    }> {
      if (queries.length === 0) return { resolved: [], ids: [], unresolved: [] };
      const resolved = await provider.resolveUsers(queries);
      const ids: string[] = [];
      const unresolved: string[] = [];
      for (const r of resolved) {
        if (r.userId) ids.push(r.userId);
        else unresolved.push(r.query);
      }
      return { resolved, ids, unresolved };
    }

    async function searchSlots(opts: {
      requiredIds: string[];
      optionalIds: string[];
      durationMinutes: number;
      earliest: Date;
      latest: Date;
      autoExtendDays?: number;
    }): Promise<SearchResult> {
      const { requiredIds, optionalIds, durationMinutes, earliest, latest } = opts;
      const autoExtendDays = opts.autoExtendDays ?? 7;
      const allAttendees = [...requiredIds, ...optionalIds];

      let result = await findCandidateSlots(provider, {
        attendees: allAttendees,
        durationMinutes,
        earliest,
        latest,
        rules,
      });
      if (result.candidates.length > 0) {
        return { ...result, strategy: "full-attendance", window: { earliest, latest } };
      }

      if (optionalIds.length > 0) {
        result = await findCandidateSlots(provider, {
          attendees: requiredIds,
          durationMinutes,
          earliest,
          latest,
          rules,
        });
        if (result.candidates.length > 0) {
          return {
            ...result,
            strategy: "required-only",
            window: { earliest, latest },
            droppedOptional: optionalIds,
          };
        }
      }

      const extendedLatest = new Date(latest.getTime() + autoExtendDays * 86400 * 1000);
      result = await findCandidateSlots(provider, {
        attendees: allAttendees,
        durationMinutes,
        earliest,
        latest: extendedLatest,
        rules,
      });
      if (result.candidates.length > 0) {
        return {
          ...result,
          strategy: "extended-window",
          window: { earliest, latest: extendedLatest },
        };
      }

      if (optionalIds.length > 0) {
        result = await findCandidateSlots(provider, {
          attendees: requiredIds,
          durationMinutes,
          earliest,
          latest: extendedLatest,
          rules,
        });
        if (result.candidates.length > 0) {
          return {
            ...result,
            strategy: "extended-required-only",
            window: { earliest, latest: extendedLatest },
            droppedOptional: optionalIds,
          };
        }
      }

      return {
        candidates: [],
        strategy: "none",
        window: { earliest, latest: extendedLatest },
      };
    }

    // -----------------------------------------------------------------------
    // Helper: format a Date in the configured timezone for human-facing text.
    // -----------------------------------------------------------------------
    function fmtLocal(d: Date): string {
      const fmt = new Intl.DateTimeFormat("zh-CN", {
        timeZone: rules.timezone,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return fmt.format(d);
    }

    // -----------------------------------------------------------------------
    // Helper: finalise a meeting once all responses are in (or someone wants
    // to force-close it). Computes mutual availability, creates the real
    // calendar event, DMs the initiator, and marks the meeting closed.
    //
    // Returns a summary string for the caller to relay to the LLM.
    // -----------------------------------------------------------------------
    async function finaliseMeeting(m: PendingMeeting): Promise<string> {
      const fT0 = Date.now();
      // eslint-disable-next-line no-console
      console.error(
        `[meeting-scheduler] finaliseMeeting ENTER meetingId=${m.id} title="${m.title}"`,
      );
      if (m.closed) {
        // eslint-disable-next-line no-console
        console.error(
          `[meeting-scheduler] finaliseMeeting: meeting=${m.id} already closed, no-op`,
        );
        return "Meeting already closed.";
      }

      // Clear any debounce timer — we are the finalization now.
      if (m.finalizeTimer) {
        clearTimeout(m.finalizeTimer);
        m.finalizeTimer = undefined;
      }

      // Build per-attendee availability windows.
      // - accepted   → the entire original window is fine
      // - proposed_alt → only their proposed_windows
      // - declined / pending → no windows (they don't constrain)
      const acceptedOrAlt = m.attendees.filter(
        (a) => a.status === "accepted" || a.status === "proposed_alt",
      );
      const declined = m.attendees.filter((a) => a.status === "declined");
      // eslint-disable-next-line no-console
      console.error(
        `[meeting-scheduler] finaliseMeeting attendee breakdown: acceptedOrAlt=${acceptedOrAlt.length} declined=${declined.length} total=${m.attendees.length}`,
      );

      if (acceptedOrAlt.length === 0) {
        // Nobody is available — close as failed.
        m.closed = true;
        const text =
          `会议《${m.title}》无法成立: 所有受邀人都已拒绝或未回复。` +
          (declined.length > 0
            ? ` 拒绝: ${declined.length}, 未回复: ${
                m.attendees.length - acceptedOrAlt.length - declined.length
              }`
            : "");
        await safeDM(m.initiatorOpenId, text);
        return text;
      }

      const perAttendee: Window[][] = acceptedOrAlt.map((a) => {
        if (a.status === "accepted") {
          return [
            { start: m.originalWindow.earliest, end: m.originalWindow.latest },
          ];
        }
        return (a.proposedWindows ?? []).map((w) => ({ start: w.start, end: w.end }));
      });

      const initial: Window[] = [
        { start: m.originalWindow.earliest, end: m.originalWindow.latest },
      ];
      const intersected = intersectManyWindows(initial, perAttendee);
      // eslint-disable-next-line no-console
      console.error(
        `[meeting-scheduler] finaliseMeeting intersected=${intersected.length} windows`,
      );

      if (intersected.length === 0) {
        m.closed = true;
        const text =
          `会议《${m.title}》无法找到所有人的共同时段。\n` +
          buildResponseRollCall(m);
        await safeDM(m.initiatorOpenId, text);
        return text;
      }

      // Find a slot of the requested duration inside the intersection.
      const candidates = findSlotsInWindows(
        intersected,
        m.durationMinutes,
        rules,
      );
      // eslint-disable-next-line no-console
      console.error(
        `[meeting-scheduler] finaliseMeeting slotCandidates=${candidates.length} duration=${m.durationMinutes}min`,
      );

      if (candidates.length === 0) {
        m.closed = true;
        const text =
          `会议《${m.title}》在共同时段内放不下 ${m.durationMinutes} 分钟。\n` +
          buildResponseRollCall(m);
        await safeDM(m.initiatorOpenId, text);
        return text;
      }

      const best = candidates[0];
      // eslint-disable-next-line no-console
      console.error(
        `[meeting-scheduler] finaliseMeeting picked slot ${best.start.toISOString()} – ${best.end.toISOString()}`,
      );

      // Create the real calendar event with all confirmed attendees.
      const finalAttendees = acceptedOrAlt.map((a) => a.openId);
      // eslint-disable-next-line no-console
      console.error(
        `[meeting-scheduler] finaliseMeeting → provider.createEvent attendees=${JSON.stringify(
          finalAttendees,
        )}`,
      );
      try {
        const event = await provider.createEvent({
          title: m.title,
          description: m.description,
          start: best.start,
          end: best.end,
          attendees: finalAttendees,
          timezone: m.timezone,
        });
        m.finalEventId = event.id;
        m.closed = true;
        // eslint-disable-next-line no-console
        console.error(
          `[meeting-scheduler] finaliseMeeting CREATED eventId=${event.id} +${Date.now() - fT0}ms`,
        );

        const summary =
          `已为《${m.title}》锁定时间: ${fmtLocal(best.start)} – ${fmtLocal(best.end)}。\n` +
          `最终参会人 (${finalAttendees.length}): 已通过飞书日历发送邀请。\n` +
          (declined.length > 0 ? `拒绝: ${declined.length} 人。\n` : "") +
          (event.joinUrl ? `会议链接: ${event.joinUrl}` : "");
        await safeDM(m.initiatorOpenId, summary);
        return summary;
      } catch (err: any) {
        m.closed = true;
        // eslint-disable-next-line no-console
        console.error(
          `[meeting-scheduler] finaliseMeeting createEvent FAILED +${Date.now() - fT0}ms: ${String(
            err?.message ?? err,
          )}`,
        );
        const text = `会议《${m.title}》创建日历事件失败: ${String(err?.message ?? err)}`;
        await safeDM(m.initiatorOpenId, text);
        return text;
      }
    }

    // -----------------------------------------------------------------------
    // Helper: schedule a delayed finalization for a meeting.
    //
    // Called when record_attendee_response sees "all responded". Instead of
    // committing the calendar event immediately, we wait FINALIZE_DELAY_MS
    // (30s) so the attendee has a short window to send a correction. Any
    // new call to this function cancels the pending timer and re-schedules
    // it, effectively giving the user "debounce-ish" safety without
    // requiring a separate message-level buffer.
    //
    // If the meeting is ALREADY finalized or closed, this is a no-op.
    // -----------------------------------------------------------------------
    function scheduleFinalize(m: PendingMeeting): void {
      if (m.closed) return;
      // Cancel any in-flight timer so the fresh response resets the clock.
      if (m.finalizeTimer) {
        // eslint-disable-next-line no-console
        console.error(
          `[meeting-scheduler] scheduleFinalize: cancelling prior timer for ${m.id} and rescheduling`,
        );
        clearTimeout(m.finalizeTimer);
        m.finalizeTimer = undefined;
      }
      m.finalizeScheduledAt = Date.now() + FINALIZE_DELAY_MS;
      // eslint-disable-next-line no-console
      console.error(
        `[meeting-scheduler] scheduleFinalize: meeting=${m.id} will finalise at ${new Date(
          m.finalizeScheduledAt,
        ).toISOString()} (+${FINALIZE_DELAY_MS}ms)`,
      );
      m.finalizeTimer = setTimeout(async () => {
        m.finalizeTimer = undefined;
        // A new response could have re-opened the meeting (pending > 0)
        // or someone might have closed it via expiry. Re-check guards.
        if (m.closed) {
          // eslint-disable-next-line no-console
          console.error(
            `[meeting-scheduler] finalize timer fired but meeting=${m.id} already closed; skipping`,
          );
          return;
        }
        const stillPending = m.attendees.filter((a) => a.status === "pending").length;
        if (stillPending > 0) {
          // eslint-disable-next-line no-console
          console.error(
            `[meeting-scheduler] finalize timer fired but meeting=${m.id} has ${stillPending} still-pending attendees; skipping`,
          );
          return;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[meeting-scheduler] finalize timer fired for meeting=${m.id}; invoking finaliseMeeting`,
        );
        try {
          await finaliseMeeting(m);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[meeting-scheduler] delayed finalize failed for ${m.id}: ${String(
              (err as any)?.message ?? err,
            )}`,
          );
        }
      }, FINALIZE_DELAY_MS);
    }

    // -----------------------------------------------------------------------
    // Helper: send a text DM via the provider, swallowing errors so an
    // unreachable user doesn't crash the whole flow. Logs the failure.
    // -----------------------------------------------------------------------
    async function safeDM(openId: string, text: string): Promise<void> {
      if (typeof provider.sendTextDM !== "function") return;
      try {
        await provider.sendTextDM(openId, text);
      } catch (err) {
        // Failed sends become console errors; the meeting state advances anyway.
        // eslint-disable-next-line no-console
        console.error(
          `[meeting-scheduler] sendTextDM failed for ${openId}: ${String(err)}`,
        );
      }
    }

    // -----------------------------------------------------------------------
    // Helper: format a roll-call snippet of who responded with what.
    // -----------------------------------------------------------------------
    function buildResponseRollCall(m: PendingMeeting): string {
      const lines: string[] = [];
      for (const a of m.attendees) {
        const tag =
          a.status === "accepted"
            ? "✓ 已接受"
            : a.status === "declined"
              ? "✗ 已拒绝"
              : a.status === "proposed_alt"
                ? `~ 建议改时间 (${(a.proposedWindows ?? [])
                    .map((w) => `${fmtLocal(w.start)}–${fmtLocal(w.end)}`)
                    .join(", ")})`
                : "… 未回复";
        lines.push(`- ${a.openId}: ${tag}` + (a.note ? `  // ${a.note}` : ""));
      }
      return lines.join("\n");
    }

    // -----------------------------------------------------------------------
    // Background ticker: every minute, walk all pending meetings and
    //   - DM the initiator a status roll-call every STATUS_UPDATE_INTERVAL_MS
    //     for as long as the meeting is still open
    //   - Close + notify when PENDING_TTL_MS has passed
    //
    // Stored in a closure so it survives the entire plugin lifetime. We
    // don't unref() because we WANT it to keep the gateway alive.
    // -----------------------------------------------------------------------
    const tickerHandle = setInterval(async () => {
      const now = Date.now();
      gcPending(now);
      for (const m of Array.from(pendingMeetings.values())) {
        if (m.closed) continue;

        // Expiry check first
        if (now >= m.expiresAt) {
          m.closed = true;
          if (m.finalizeTimer) {
            clearTimeout(m.finalizeTimer);
            m.finalizeTimer = undefined;
          }
          const text =
            `会议《${m.title}》已超过 12 小时仍未收齐回复，已自动取消。\n` +
            buildResponseRollCall(m) +
            `\n如需继续，请重新发起。`;
          await safeDM(m.initiatorOpenId, text);
          continue;
        }

        // Periodic status update for the initiator
        const lastUpdate = m.lastStatusUpdateAt || m.createdAt;
        if (now - lastUpdate >= STATUS_UPDATE_INTERVAL_MS) {
          const pendingCount = m.attendees.filter(
            (a) => a.status === "pending",
          ).length;
          const repliedCount = m.attendees.length - pendingCount;
          const text =
            `《${m.title}》状态更新 (${repliedCount}/${m.attendees.length} 已回复):\n` +
            buildResponseRollCall(m) +
            `\n剩余等待时间: ${Math.max(0, Math.round((m.expiresAt - now) / 60000))} 分钟。`;
          await safeDM(m.initiatorOpenId, text);
          m.lastStatusUpdateAt = now;
        }
      }
    }, TICKER_INTERVAL_MS);
    // Keep a reference around so a future shutdown hook could clear it.
    void tickerHandle;

    // =======================================================================
    // Tool 1: find_and_book_meeting
    //
    // NEW BEHAVIOUR: does NOT create a calendar event directly. It creates
    // a PendingMeeting in the in-memory store and DMs each attendee asking
    // for their availability. The real calendar event is created later by
    // finaliseMeeting() once all attendees respond (or someone force-closes).
    // =======================================================================
    api.registerTool((ctx: any /* OpenClawPluginToolContext */) => {
      // Trusted, never from LLM: open_id of the human triggering this tool.
      // Source: OpenClawPluginToolContext.requesterSenderId (citation 3
      // at the top of this file).
      const senderOpenId: string | undefined = ctx?.requesterSenderId;

      const parameters = {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "Meeting title / 会议标题" },
          description: { type: "string", description: "Optional agenda" },
          required_attendees: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description:
              "REQUIRED. At least one attendee. Accepts ANY of the " +
              "following identifier formats — pick whichever the user " +
              "actually said:\n" +
              "  - display name in Chinese or English (e.g. '安农', '李思', " +
              "'Alice') — the plugin will resolve it against the tenant " +
              "directory via /contact/v3/users/find_by_department\n" +
              "  - email address (e.g. alice@company.com)\n" +
              "  - phone number (digits, optional +)\n" +
              "  - Feishu open_id (only if the user actually pasted one)\n" +
              "DO NOT fabricate open_ids. If the user said names, pass the " +
              "names verbatim — do NOT translate them to anything else.",
          },
          duration_minutes: { type: "number", default: 30 },
          earliest: {
            type: "string",
            description:
              "RFC3339 with timezone, e.g. 2026-04-09T14:00:00+08:00",
          },
          latest: {
            type: "string",
            description: "RFC3339 with timezone",
          },
        },
        required: ["title", "required_attendees", "earliest", "latest"],
      };

      return {
        name: "find_and_book_meeting",
        label: "Find and book meeting",
        description:
          "🚨 MANDATORY TOOL — DO NOT IGNORE 🚨\n" +
          "\n" +
          "If the user's message contains ANY of these phrases, you MUST " +
          "call this tool. You are FORBIDDEN from replying with plain text:\n" +
          "  约会议 / 约个会 / 约会 / 帮我约 / 安排会议 / 安排一个会 / 开个会 / 发起一个会议 / 发起会议\n" +
          "\n" +
          "DO NOT pretend you called the tool. DO NOT fabricate confirmation " +
          "messages like '已为你安排' or '已发送邀请'. If you do not call " +
          "this tool, NOTHING happens — the user gets nothing, no DM is " +
          "sent, no event is created. The user will know you lied because " +
          "the recipient will receive nothing.\n" +
          "\n" +
          `Current date table (use these EXACT dates, do NOT compute):\n${currentDateHint()}\n\n` +
          "WORKFLOW:\n" +
          "1. This tool creates a pending meeting and DMs each attendee.\n" +
          "2. Attendees reply in their own DM session; that triggers a " +
          "different LLM session which calls list_my_pending_invitations + " +
          "record_attendee_response.\n" +
          "3. Plugin auto-finalizes when all responses are in, or 12h.\n\n" +
          "ATTENDEE RULES:\n" +
          "- required_attendees MUST be a non-empty array.\n" +
          "- Accepted identifiers: display name (Chinese/English), email, " +
          "phone, or open_id — pass VERBATIM as the user said them.\n" +
          "- The message sender is auto-included; you do NOT need to add them.\n" +
          "- If the user did not name anyone, DO NOT call this tool — ASK " +
          "them who to invite first.\n" +
          "\n" +
          "TWO-STEP NAME RESOLUTION:\n" +
          "- When you pass a display name, the plugin looks it up in the " +
          "Feishu tenant directory (/contact/v3/users/find_by_department). " +
          "The plugin does NOT do string matching — it returns the full " +
          "candidate list and expects YOU to pick the right open_id.\n" +
          "- If this tool returns `reason: \"unresolved_names\"` with a " +
          "`candidates` array in details, READ the candidates carefully, " +
          "decide which one matches the user's intent (consider name, " +
          "en_name, nickname, email), then RE-INVOKE this tool with the " +
          "chosen user's open_id in required_attendees. DO NOT give up " +
          "on the first attempt. DO NOT ask the user for an open_id — " +
          "pick the best candidate yourself using your language understanding.\n" +
          "- If NO candidate clearly matches, THEN ask the user to clarify " +
          "by department / full name / email.\n" +
          "\n" +
          "AFTER THIS TOOL RETURNS (and only after — never before):\n" +
          "- Quote the tool's `details` in your reply. Do not invent fields.\n" +
          "- If `dispatched > 0`: tell the user '已向 N 位参会人发送邀请，" +
          "等待他们回复'.\n" +
          "- If `dispatched == 0` and `failedDispatch.length > 0`: tell the " +
          "user the DM send FAILED and they should check the bot's permissions.\n" +
          "- NEVER claim a meeting is 'arranged' or 'confirmed' — at this " +
          "stage it is only PENDING. The final time is computed later.",
        parameters: parameters as any,

        execute: async (_toolCallId: string, params: any) => {
          const p = params ?? {};
          const t0 = Date.now();
          const trace = (step: string) => {
            // eslint-disable-next-line no-console
            console.error(
              `[meeting-scheduler] ${step} (+${Date.now() - t0}ms)`,
            );
          };

          // Debug breadcrumb so we can grep openclaw logs and confirm the
          // tool was actually called.
          // eslint-disable-next-line no-console
          console.error(
            `[meeting-scheduler] find_and_book_meeting INVOKED sender=${
              senderOpenId ?? "<none>"
            } params=${JSON.stringify(p).slice(0, 500)}`,
          );

          if (!senderOpenId) {
            return toolResult(
              "Cannot create a pending meeting: no trusted sender id available " +
                "in the session context. The plugin needs to know who the initiator is.",
              { ok: false, reason: "no_sender" },
            );
          }

          // ========================================================
          // LAYER 1: in-flight dedup BEFORE any expensive work.
          // ========================================================
          // Kimi-K2.5 sometimes fires dozens of identical parallel tool
          // calls in one turn. Without this early check, each one walked
          // the full Feishu directory (~240ms) before the post-resolve
          // idempotency guard stopped them. We now compute a fingerprint
          // on the RAW params and dedupe concurrent requests via a
          // shared Promise — the first caller does the real work, all
          // others await the same promise and return immediately.
          const rawAttendeesForKey = asArray<string>(p.required_attendees);
          const inflightKey = rawRequestKey({
            sender: senderOpenId,
            title: String(p.title ?? ""),
            earliest: String(p.earliest ?? ""),
            latest: String(p.latest ?? ""),
            duration: Number(p.duration_minutes ?? 30),
            attendees: rawAttendeesForKey,
          });
          const existing = inflightFindAndBook.get(inflightKey);
          if (existing) {
            // eslint-disable-next-line no-console
            console.error(
              `[meeting-scheduler] in-flight dedup hit rawKey=${inflightKey.slice(
                0,
                12,
              )}… — awaiting existing promise`,
            );
            try {
              const result = await existing;
              return result;
            } catch {
              // If the first caller failed, fall through and retry ourselves.
              // eslint-disable-next-line no-console
              console.error(
                `[meeting-scheduler] in-flight leader failed; this caller will retry`,
              );
            }
          }

          // We're the leader. Wrap the real work in a promise, register
          // it in the in-flight map, and ALWAYS remove it in finally so
          // failures don't pin the slot forever.
          const workPromise = (async () => {
          try {

          let requiredQ = normalizeAttendees(asArray<string>(p.required_attendees));

          // Auto-include the initiator. They are an implicit attendee
          // (they're the one who wants the meeting).
          if (!requiredQ.includes(senderOpenId)) {
            requiredQ = [senderOpenId, ...requiredQ];
          }
          trace(`normalized attendees: ${JSON.stringify(requiredQ)}`);

          trace("resolveAll start");
          const reqResolved = await resolveAll(requiredQ);
          trace(
            `resolveAll done ids=${reqResolved.ids.length} unresolved=${JSON.stringify(reqResolved.unresolved)}`,
          );
          // Fail EARLY if ANY requested attendee is unresolved. The previous
          // version silently dropped unresolved names and continued with the
          // sender only, which silently turned "schedule with 安子岩" into
          // "schedule with only yourself". That's the opposite of what the
          // user asked for.
          //
          // When the provider couldn't match a name, it attaches the full
          // tenant directory snapshot on the ResolvedUser.candidates field.
          // We surface those candidates to the LLM so it can pick the right
          // user and retry this tool with the exact open_id. The plugin
          // does NO name matching itself — the LLM is smarter about it.
          if (reqResolved.unresolved.length > 0) {
            const unresolvedEntries = reqResolved.resolved.filter(
              (r) => !r.userId && r.candidates && r.candidates.length > 0,
            );
            // De-duplicate candidates by userId across queries (all name
            // queries share the same tenant snapshot, so they are identical).
            const candSet = new Map<string, any>();
            for (const e of unresolvedEntries) {
              for (const c of e.candidates ?? []) {
                if (!candSet.has(c.userId)) candSet.set(c.userId, c);
              }
            }
            const candList = Array.from(candSet.values());
            const candLines = candList.map((c, i) => {
              const aliases = [c.name, c.en_name, c.nickname, c.email]
                .filter(Boolean)
                .join(" / ");
              return `${i + 1}. ${aliases}  → open_id=${c.userId}`;
            });
            trace(
              `returning unresolved_names with ${candList.length} candidates; unresolved=${JSON.stringify(
                reqResolved.unresolved,
              )}`,
            );
            // eslint-disable-next-line no-console
            console.error(
              `[meeting-scheduler] candidates returned to LLM:\n${candLines
                .map((l) => "  " + l)
                .join("\n")}`,
            );
            return toolResult(
              "Some attendees could not be resolved by name: " +
                JSON.stringify(reqResolved.unresolved) +
                ".\n\n" +
                "Below is the tenant directory the plugin sees. " +
                "PICK the user the initiator meant and RE-INVOKE " +
                "find_and_book_meeting with that user's open_id in " +
                "required_attendees (not the name). Do NOT guess — if " +
                "no candidate clearly matches, reply to the initiator " +
                "asking them to clarify.\n\n" +
                "Candidates (" +
                candList.length +
                " total):\n" +
                candLines.join("\n"),
              {
                ok: false,
                reason: "unresolved_names",
                unresolved: reqResolved.unresolved,
                candidates: candList,
              },
            );
          }

          if (reqResolved.ids.length === 0) {
            return toolResult(
              "Could not resolve any attendees.",
              { ok: false, reason: "unresolved" },
            );
          }

          const earliest = new Date(p.earliest);
          const latest = new Date(p.latest);
          if (
            isNaN(earliest.getTime()) ||
            isNaN(latest.getTime()) ||
            earliest >= latest
          ) {
            trace(
              `bad_window earliest=${p.earliest} latest=${p.latest}`,
            );
            return toolResult(
              "Invalid time window. earliest must be before latest, both ISO-8601 " +
                "with timezone.",
              { ok: false, reason: "bad_window" },
            );
          }
          trace(
            `window parsed earliest=${earliest.toISOString()} latest=${latest.toISOString()} spanHours=${(
              (latest.getTime() - earliest.getTime()) /
              3600000
            ).toFixed(1)}`,
          );

          const durationMinutes = Number(p.duration_minutes ?? 30);
          const now = Date.now();

          // ----- Tool-level idempotency -----
          // If the LLM retries or hallucinates a second identical call within
          // IDEMPOTENCY_WINDOW_MS, return the first meetingId instead of
          // creating a second PendingMeeting (which would DM every attendee
          // again). Key on the stable request fingerprint.
          gcIdempotency(now);
          const sortedAttIds = [...reqResolved.ids].sort();
          const idemKey = createHash("sha256")
            .update(
              [
                senderOpenId,
                String(p.title),
                earliest.toISOString(),
                latest.toISOString(),
                String(durationMinutes),
                sortedAttIds.join(","),
              ].join("|"),
            )
            .digest("hex");
          const prior = recentFindAndBook.get(idemKey);
          if (prior) {
            const existing = pendingMeetings.get(prior.meetingId);
            if (existing && !existing.closed) {
              trace(`idempotency hit meetingId=${prior.meetingId}`);
              return toolResult(
                `Duplicate request detected within ${
                  IDEMPOTENCY_WINDOW_MS / 1000
                }s window. ` +
                  `Existing pending meeting ${prior.meetingId} reused; no new DMs sent.`,
                {
                  ok: true,
                  duplicate: true,
                  meetingId: prior.meetingId,
                  attendees: existing.attendees.map((a) => ({
                    openId: a.openId,
                    status: a.status,
                  })),
                },
              );
            }
            // Prior meeting already closed → fall through and create a fresh one.
          }

          const meetingId = newMeetingId();
          recentFindAndBook.set(idemKey, { meetingId, at: now });

          const meeting: PendingMeeting = {
            id: meetingId,
            initiatorOpenId: senderOpenId,
            title: String(p.title),
            description: p.description ? String(p.description) : undefined,
            originalWindow: { earliest, latest },
            durationMinutes,
            timezone: rules.timezone,
            attendees: reqResolved.ids.map((openId) => ({
              openId,
              // The initiator is auto-accepted (they obviously can attend
              // their own meeting). Other attendees start pending.
              status: openId === senderOpenId ? "accepted" : "pending",
              respondedAt: openId === senderOpenId ? now : undefined,
            })),
            createdAt: now,
            expiresAt: now + PENDING_TTL_MS,
            lastStatusUpdateAt: now, // suppress an immediate ticker update
            closed: false,
          };
          pendingMeetings.set(meetingId, meeting);
          trace(
            `PendingMeeting created id=${meetingId} attendees=${meeting.attendees
              .map((a) => `${a.openId}(${a.status})`)
              .join(",")} expiresAt=${new Date(meeting.expiresAt).toISOString()}`,
          );

          // Send DM invitation to each non-initiator attendee.
          const inviteText =
            `您收到一个会议邀请: 《${meeting.title}》\n` +
            (meeting.description ? `说明: ${meeting.description}\n` : "") +
            `初步时间范围: ${fmtLocal(earliest)} – ${fmtLocal(latest)}\n` +
            `时长: ${durationMinutes} 分钟\n` +
            `\n请直接回复我:\n` +
            `  - 同意整段时间: 比如 "接受" / "同意" / "可以"\n` +
            `  - 只在某段时间有空: 比如 "我只有明天 13:00-14:00 有空"\n` +
            `  - 拒绝: 比如 "拒绝" / "不行"\n` +
            `\n超过 12 小时未回复将自动取消。`;

          const sent: string[] = [];
          const failed: string[] = [];
          for (const a of meeting.attendees) {
            if (a.openId === senderOpenId) continue;
            trace(`sending invite DM to ${a.openId}`);
            try {
              if (typeof provider.sendTextDM !== "function") {
                throw new Error("provider.sendTextDM is not implemented");
              }
              const messageId = await provider.sendTextDM(a.openId, inviteText);
              sent.push(a.openId);
              // eslint-disable-next-line no-console
              console.error(
                `[meeting-scheduler] invite DM sent to ${a.openId} msgId=${messageId}`,
              );
            } catch (err) {
              failed.push(a.openId);
              // eslint-disable-next-line no-console
              console.error(
                `[meeting-scheduler] invite DM FAILED for ${a.openId}: ${String((err as any)?.message ?? err)}`,
              );
            }
          }

          trace(
            `find_and_book_meeting DONE sent=${sent.length} failed=${failed.length} meetingId=${meetingId}`,
          );
          return toolResult(
            `已创建待定会议《${meeting.title}》(id=${meetingId})。` +
              `已向 ${sent.length} 位参会人发送邀请DM,` +
              (failed.length > 0 ? `${failed.length} 人发送失败,` : "") +
              `等待回复中。所有人回复后或 12h 超时后会自动通知发起者。`,
            {
              ok: true,
              meetingId,
              attendeeCount: meeting.attendees.length,
              dispatched: sent.length,
              failedDispatch: failed,
              expiresAt: new Date(meeting.expiresAt).toISOString(),
            },
          );

          } catch (err: any) {
            // Catch-all so an unexpected exception inside the tool body
            // can never freeze the agent loop. Logs the failure with
            // elapsed time so we can correlate against the gateway logs.
            // eslint-disable-next-line no-console
            console.error(
              `[meeting-scheduler] find_and_book_meeting EXCEPTION (+${Date.now() - t0}ms): ${String(
                err?.message ?? err,
              )}\n${err?.stack ?? ""}`,
            );
            return toolResult(
              `Internal error in find_and_book_meeting: ${String(err?.message ?? err)}`,
              { ok: false, reason: "exception", message: String(err?.message ?? err) },
            );
          }
          })();
          // Register the in-flight promise BEFORE awaiting it so any
          // concurrent caller that arrives after we start (but before we
          // finish) will see it and dedupe.
          inflightFindAndBook.set(inflightKey, workPromise);
          try {
            return await workPromise;
          } finally {
            // Drop the slot once the work settles. A tiny delay would let
            // very-fast follow-up retries still hit the dedup, but the
            // post-resolve fingerprint (layer 2) already covers sequential
            // retries, so we clean up immediately.
            inflightFindAndBook.delete(inflightKey);
          }
        },
      };
    });

    // =======================================================================
    // Tool 2: list_my_pending_invitations
    //
    // The LLM should call this BEFORE record_attendee_response when the
    // current sender's message looks like a meeting reply, so it can find
    // the meetingId to record against.
    // =======================================================================
    api.registerTool((ctx: any) => {
      const senderOpenId: string | undefined = ctx?.requesterSenderId;

      return {
        name: "list_my_pending_invitations",
        label: "List my pending meeting invitations",
        description:
          "Look up which pending meeting invitations the current message " +
          "sender has been invited to but not yet responded to. Call this " +
          "FIRST whenever the user's message looks like a reply to a meeting " +
          "invite — phrases like '接受', '同意', '拒绝', '我有空', '我只有...有空', " +
          "'我不行', '可以', '行', '不行', etc. Returns an array; pick the " +
          "right meeting (usually there is exactly one) and pass its meetingId " +
          "to record_attendee_response.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        } as any,
        execute: async (_toolCallId: string) => {
          if (!senderOpenId) {
            return toolResult("No trusted sender id in context.", {
              ok: false,
              meetings: [],
            });
          }
          const matches: any[] = [];
          for (const m of pendingMeetings.values()) {
            if (m.closed) continue;
            const myEntry = m.attendees.find(
              (a) => a.openId === senderOpenId && a.status === "pending",
            );
            if (myEntry) {
              matches.push({
                meetingId: m.id,
                title: m.title,
                description: m.description,
                originalWindow: {
                  earliest: m.originalWindow.earliest.toISOString(),
                  latest: m.originalWindow.latest.toISOString(),
                  earliestLocal: fmtLocal(m.originalWindow.earliest),
                  latestLocal: fmtLocal(m.originalWindow.latest),
                },
                durationMinutes: m.durationMinutes,
                initiatorOpenId: m.initiatorOpenId,
                expiresAt: new Date(m.expiresAt).toISOString(),
              });
            }
          }
          return toolResult(
            `Found ${matches.length} pending invitation(s) for you.`,
            { ok: true, meetings: matches },
          );
        },
      };
    });

    // =======================================================================
    // Tool 3: record_attendee_response
    //
    // Called by the LLM after parsing the attendee's natural-language reply.
    //
    // IMPORTANT CHANGES from the naive "last wins" version:
    //   1. `mode` param (default "append") controls whether new windows are
    //      UNIONED with the existing state or overwrite it. This prevents a
    //      typo or fat-finger second message from nuking a good first answer.
    //   2. When `mode === "append"` we merge new windows with any existing
    //      proposed_windows (de-duplicating overlapping intervals).
    //   3. Finalisation (creating the real calendar event when everyone has
    //      responded) is DELAYED by FINALIZE_DELAY_MS. A new call during
    //      that delay cancels and re-schedules, giving the attendee a
    //      short buffer to correct themselves.
    //   4. The tool returns the PREVIOUS entry state in `details.previous`
    //      so the LLM can see what was already recorded and decide to
    //      append vs replace correctly.
    // =======================================================================
    api.registerTool((ctx: any) => {
      const senderOpenId: string | undefined = ctx?.requesterSenderId;

      const parameters = {
        type: "object",
        additionalProperties: false,
        properties: {
          meetingId: {
            type: "string",
            description:
              "Meeting id. OPTIONAL — if omitted, the plugin auto-resolves " +
              "to the sender's ONLY pending invitation (most common case). " +
              "Only pass this explicitly if the sender has multiple pending " +
              "invitations and you need to pick one.",
          },
          status: {
            type: "string",
            enum: ["accepted", "declined", "proposed_alt"],
            description:
              "accepted = full agreement with the original window; " +
              "declined = cannot attend at all; " +
              "proposed_alt = available only within the proposed_windows.",
          },
          proposed_windows: {
            type: "array",
            description:
              "Required when status='proposed_alt'. Each entry is an ISO-8601 " +
              "interval the attendee is available in.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                start: { type: "string", description: "RFC3339 with timezone" },
                end: { type: "string", description: "RFC3339 with timezone" },
              },
              required: ["start", "end"],
            },
          },
          mode: {
            type: "string",
            enum: ["append", "replace"],
            default: "append",
            description:
              "How to combine this response with any previous response from " +
              "the same attendee:\n" +
              "- append (default): UNION new windows with existing ones. Use " +
              "this when the attendee is adding another available time (e.g. " +
              "'另外我周二 15-16 也可以') OR when you are uncertain whether " +
              "the new message is a correction or a noise/typo.\n" +
              "- replace: OVERWRITE previous windows entirely. ONLY use this " +
              "when the attendee EXPLICITLY corrects themselves (e.g. '不对,' " +
              "'改一下', '其实是', '取消刚才的').",
          },
          note: {
            type: "string",
            description: "Optional free-text note from the attendee, passed through verbatim.",
          },
        },
        required: ["status"],
      };

      return {
        name: "record_attendee_response",
        label: "Record attendee response",
        description:
          "Record an attendee's response to a pending meeting invitation.\n" +
          "\n" +
          "WHEN TO CALL: If the user's message sounds like a reply to a " +
          "meeting invite (接受/同意/可以/行/好/拒绝/不行/不能/我有空/某个时间段), " +
          "call this tool DIRECTLY. You do NOT need to call " +
          "list_my_pending_invitations first — just omit meetingId and the " +
          "plugin auto-resolves to the sender's pending invitation.\n" +
          "\n" +
          "STATUS MAPPING:\n" +
          "  - 接受/同意/可以/没问题/行/好/好的/没事/你看着来/都可以 → status='accepted'\n" +
          "  - 拒绝/不行/不能/没空/我去不了 → status='declined'\n" +
          "  - 任何提及具体时间段 → status='proposed_alt' + proposed_windows\n" +
          "\n" +
          `Date table:\n${currentDateHint()}\n` +
          "\n" +
          "MODE (default append):\n" +
          "- append: safe default, unions windows.\n" +
          "- replace: ONLY when user explicitly corrects (不对/改一下/取消).\n" +
          "- Noise (sdf, hello, ?): DO NOT call this tool, ask for clarification.\n" +
          "DO NOT call this tool at all — just reply to the attendee asking " +
          "for clarification.\n" +
          "\n" +
          "The tool returns the previous entry state in `details.previous`. " +
          "Read it to decide whether appending makes sense.\n" +
          "\n" +
          "When this records the LAST pending response, the plugin will " +
          "schedule the meeting finalisation after a short 30-second buffer " +
          "(so the attendee can still correct themselves). You should reply " +
          "to the current attendee confirming what was recorded.",
        parameters: parameters as any,

        execute: async (_toolCallId: string, params: any) => {
          const p = params ?? {};
          // Entry trace — so we can confirm in logs whether the LLM is
          // actually invoking this tool when an attendee replies.
          // eslint-disable-next-line no-console
          console.error(
            `[meeting-scheduler] record_attendee_response INVOKED sender=${
              senderOpenId ?? "<none>"
            } params=${JSON.stringify(p).slice(0, 500)}`,
          );
          if (!senderOpenId) {
            return toolResult("No trusted sender id in context.", {
              ok: false,
              reason: "no_sender",
            });
          }
          // ---- Resolve meetingId (auto if omitted) ----
          let meetingId: string | undefined = p.meetingId;
          let meeting: PendingMeeting | undefined;

          if (!meetingId) {
            // Auto-resolve: find the sender's ONLY pending invitation.
            const candidates: PendingMeeting[] = [];
            for (const m of pendingMeetings.values()) {
              if (m.closed) continue;
              const myEntry = m.attendees.find(
                (a) => a.openId === senderOpenId,
              );
              if (myEntry) candidates.push(m);
            }
            if (candidates.length === 0) {
              // eslint-disable-next-line no-console
              console.error(
                `[meeting-scheduler] record_attendee_response AUTO_RESOLVE no pending meetings for sender=${senderOpenId}`,
              );
              return toolResult(
                "No pending meeting invitation found for you. " +
                  "Either the invitation expired, was already finalised, " +
                  "or you are not a listed attendee.",
                { ok: false, reason: "no_pending" },
              );
            }
            if (candidates.length > 1) {
              // eslint-disable-next-line no-console
              console.error(
                `[meeting-scheduler] record_attendee_response AUTO_RESOLVE multiple (${candidates.length}) pending meetings for sender=${senderOpenId}`,
              );
              const list = candidates.map((c) => ({
                meetingId: c.id,
                title: c.title,
                window: `${c.originalWindow.earliest.toISOString()} – ${c.originalWindow.latest.toISOString()}`,
              }));
              return toolResult(
                `You have ${candidates.length} pending meeting invitations. ` +
                  `Please ask the user which one they are replying to, then ` +
                  `re-call this tool with the specific meetingId.`,
                { ok: false, reason: "ambiguous", meetings: list },
              );
            }
            meeting = candidates[0];
            meetingId = meeting.id;
            // eslint-disable-next-line no-console
            console.error(
              `[meeting-scheduler] record_attendee_response AUTO_RESOLVED meetingId=${meetingId} title="${meeting.title}"`,
            );
          } else {
            meeting = pendingMeetings.get(meetingId);
          }

          if (!meeting || meeting.closed) {
            // eslint-disable-next-line no-console
            console.error(
              `[meeting-scheduler] record_attendee_response NOT_FOUND meetingId=${meetingId} knownIds=${JSON.stringify(
                Array.from(pendingMeetings.keys()),
              )}`,
            );
            return toolResult(
              `Meeting ${meetingId} not found or already closed.`,
              { ok: false, reason: "not_found" },
            );
          }
          const entry = meeting.attendees.find((a) => a.openId === senderOpenId);
          if (!entry) {
            // eslint-disable-next-line no-console
            console.error(
              `[meeting-scheduler] record_attendee_response NOT_INVITED sender=${senderOpenId} meetingAttendees=${JSON.stringify(
                meeting.attendees.map((a) => a.openId),
              )}`,
            );
            return toolResult(
              `You (${senderOpenId}) are not on the attendee list for ${meetingId}.`,
              { ok: false, reason: "not_invited" },
            );
          }
          // eslint-disable-next-line no-console
          console.error(
            `[meeting-scheduler] record_attendee_response found entry sender=${senderOpenId} meetingId=${meetingId} prevStatus=${entry.status} mode=${
              p.mode ?? "append(default)"
            } newStatus=${p.status}`,
          );

          const status = p.status as AttendeeStatus;
          if (
            status !== "accepted" &&
            status !== "declined" &&
            status !== "proposed_alt"
          ) {
            return toolResult(
              `Invalid status "${status}". Must be accepted, declined, or proposed_alt.`,
              { ok: false, reason: "bad_status" },
            );
          }

          const mode: "append" | "replace" = p.mode === "replace" ? "replace" : "append";

          // Snapshot the previous entry state for the tool response.
          const previous = {
            status: entry.status,
            proposedWindows: (entry.proposedWindows ?? []).map((w) => ({
              start: w.start.toISOString(),
              end: w.end.toISOString(),
            })),
            note: entry.note,
            respondedAt: entry.respondedAt
              ? new Date(entry.respondedAt).toISOString()
              : null,
          };

          // Parse the new proposed_windows (if any).
          let newWindows: { start: Date; end: Date }[] = [];
          if (status === "proposed_alt") {
            const raw = Array.isArray(p.proposed_windows) ? p.proposed_windows : [];
            newWindows = raw
              .map((w: any) => ({
                start: new Date(w?.start),
                end: new Date(w?.end),
              }))
              .filter(
                (w: any) =>
                  !isNaN(w.start.getTime()) &&
                  !isNaN(w.end.getTime()) &&
                  w.end > w.start,
              );
            if (newWindows.length === 0) {
              return toolResult(
                "status='proposed_alt' requires at least one valid proposed_windows entry.",
                { ok: false, reason: "no_windows", previous },
              );
            }
          }

          // Merge logic.
          //
          // APPEND mode is the default and the safer choice:
          //   - If the attendee was pending → first reply, just set it.
          //   - If the attendee was already proposed_alt and the new reply
          //     is also proposed_alt → UNION the windows (then merge any
          //     overlapping intervals into coalesced ranges).
          //   - If the attendee was already proposed_alt and the new reply
          //     is accepted → becomes accepted (the broader answer wins).
          //   - If the attendee was already accepted and the new reply is
          //     proposed_alt → stay accepted but keep the new windows as
          //     an informational detail (accepted trumps narrower proposals).
          //   - If the new reply is declined → attendee explicitly backs
          //     out; status becomes declined, windows cleared.
          //
          // REPLACE mode: wholesale overwrite, exactly what the naive
          // version used to do. LLM should only ask for this when the user
          // explicitly corrects themselves.
          if (mode === "replace") {
            entry.status = status;
            entry.proposedWindows =
              status === "proposed_alt" ? newWindows : undefined;
          } else {
            // append
            if (status === "declined") {
              entry.status = "declined";
              entry.proposedWindows = undefined;
            } else if (status === "accepted") {
              entry.status = "accepted";
              entry.proposedWindows = undefined;
            } else {
              // proposed_alt
              const existing = entry.proposedWindows ?? [];
              entry.proposedWindows = mergeOverlappingWindows([
                ...existing,
                ...newWindows,
              ]);
              entry.status = "proposed_alt";
            }
          }

          if (p.note) {
            // Append notes too, don't clobber.
            entry.note = entry.note
              ? `${entry.note}\n${String(p.note)}`
              : String(p.note);
          }
          entry.respondedAt = Date.now();

          const pendingCount = meeting.attendees.filter(
            (a) => a.status === "pending",
          ).length;
          // eslint-disable-next-line no-console
          console.error(
            `[meeting-scheduler] record_attendee_response merged entry sender=${senderOpenId} ` +
              `status=${entry.status} windows=${
                (entry.proposedWindows ?? []).length
              } pendingCount=${pendingCount}/${meeting.attendees.length}`,
          );

          // Current merged state for the tool response.
          const current = {
            status: entry.status,
            proposedWindows: (entry.proposedWindows ?? []).map((w) => ({
              start: w.start.toISOString(),
              end: w.end.toISOString(),
            })),
            note: entry.note,
          };

          if (pendingCount === 0) {
            // Everyone has responded. Schedule (or re-schedule) the
            // delayed finalize rather than committing immediately.
            scheduleFinalize(meeting);
            return toolResult(
              `Recorded your response (mode=${mode}, merged status=${entry.status}). ` +
                `All attendees have now responded; the meeting will be finalised ` +
                `in ${Math.round(FINALIZE_DELAY_MS / 1000)}s unless anyone sends ` +
                `a correction in the meantime.`,
              {
                ok: true,
                mode,
                allResponded: true,
                finalised: false,
                finalizeScheduledAt: meeting.finalizeScheduledAt
                  ? new Date(meeting.finalizeScheduledAt).toISOString()
                  : null,
                meetingId: meeting.id,
                previous,
                current,
              },
            );
          }

          return toolResult(
            `Recorded your response (mode=${mode}, merged status=${entry.status}). ` +
              `${pendingCount} attendee(s) still pending.`,
            {
              ok: true,
              mode,
              allResponded: false,
              remaining: pendingCount,
              meetingId: meeting.id,
              previous,
              current,
            },
          );
        },
      };
    });

    // -----------------------------------------------------------------------
    // Tool 2: list_upcoming_meetings
    // -----------------------------------------------------------------------
    api.registerTool((_ctx: any) => ({
      name: "list_upcoming_meetings",
      label: "List upcoming meetings",
      description:
        "List meetings on the bot-owned calendar within the next N hours.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          hours: {
            type: "number",
            default: 24,
            description: "Look-ahead window in hours.",
          },
        },
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const hours = params?.hours ?? 24;
        const events = await provider.listUpcoming(
          cfg.ORGANIZER_EMAIL || "organizer",
          hours,
        );
        return toolResult(
          `${events.length} upcoming meetings in the next ${hours}h.`,
          { ok: true, count: events.length, events },
        );
      },
    }));

    // -----------------------------------------------------------------------
    // Tool 3: cancel_meeting
    // -----------------------------------------------------------------------
    api.registerTool((_ctx: any) => ({
      name: "cancel_meeting",
      label: "Cancel meeting",
      description: "Cancel a previously created meeting by event id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          eventId: {
            type: "string",
            description: "Event id returned by find_and_book_meeting.",
          },
        },
        required: ["eventId"],
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        await provider.cancelEvent(params.eventId);
        return toolResult(`Cancelled event ${params.eventId}.`, { ok: true });
      },
    }));

    // -----------------------------------------------------------------------
    // Tool 4: debug_list_directory
    //
    // Diagnostic helper. Lists every user the plugin sees in the tenant
    // directory (via /contact/v3/users/find_by_department with dept="0").
    // Useful when a name-based lookup fails: you can see exactly what
    // `name` / `en_name` / `nickname` values the directory returned and
    // pick one that matches.
    // -----------------------------------------------------------------------
    api.registerTool((_ctx: any) => ({
      name: "debug_list_directory",
      label: "Debug: list tenant directory",
      description:
        "DIAGNOSTIC tool. Dumps the list of users the plugin can see in " +
        "the Feishu tenant directory (what find_by_department returns). " +
        "Trigger phrases: 显示通讯录, 列出通讯录, 看看通讯录, list directory, " +
        "debug directory, 查看可见用户. Returns name, en_name, nickname, " +
        "and open_id prefix for each user.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "number",
            default: 30,
            description: "Max users to return.",
          },
        },
      } as any,
      execute: async (_toolCallId: string, params: any) => {
        const limit = Math.max(1, Math.min(200, Number(params?.limit ?? 30)));
        try {
          const lark = provider as any;
          if (typeof lark.listAllUsers !== "function") {
            return toolResult(
              "Current provider does not expose listAllUsers (only Lark does).",
              { ok: false, reason: "not_lark" },
            );
          }
          const users: any[] = await lark.listAllUsers();
          const total = users.length;
          const rows = users.slice(0, limit).map((u) => ({
            name: u.name ?? "",
            en_name: u.en_name ?? "",
            nickname: u.nickname ?? "",
            email: u.email ?? "",
            open_id_prefix: (u.open_id ?? "").slice(0, 16) + "…",
          }));
          const lines = rows.map(
            (r, i) =>
              `${i + 1}. name="${r.name}" en_name="${r.en_name}" nickname="${r.nickname}" open_id=${r.open_id_prefix}`,
          );
          return toolResult(
            `Directory has ${total} user(s). Showing first ${rows.length}:\n` +
              lines.join("\n") +
              (total > rows.length
                ? `\n... and ${total - rows.length} more`
                : ""),
            { ok: true, total, users: rows },
          );
        } catch (err: any) {
          return toolResult(
            `listAllUsers failed: ${String(err?.message ?? err)}`,
            { ok: false, reason: "exception", message: String(err?.message ?? err) },
          );
        }
      },
    }));
  },
};

export default plugin;
module.exports = plugin;
