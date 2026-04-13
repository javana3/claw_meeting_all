/**
 * Shared meeting-scheduler plugin core — MULTI-PLATFORM ROUTING.
 *
 * Exports `createMeetingPlugin(options)` which accepts MULTIPLE platform
 * configs. A single plugin instance registers 6 tools. On each tool call,
 * `ctx.messageChannel` determines which CalendarProvider to use.
 *
 * Adding a new platform requires:
 *   1. Implement CalendarProvider
 *   2. Add a PlatformConfig entry in the platforms map
 *   3. Done — no tool name conflicts, no separate plugins
 */

import { createHash } from "node:crypto";
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
// Public types
// ============================================================================

/** Per-platform configuration. */
export interface PlatformConfig {
  /** Factory that creates a CalendarProvider from the resolved config. */
  createProvider: (cfg: Record<string, string>) => CalendarProvider;
  /** Regex to validate a platform user ID. */
  userIdPattern: RegExp;
  /** Quick check: does this raw string start with a user ID prefix? */
  looksLikeUserId: (s: string) => boolean;
  /** Platform display name for tool descriptions. */
  platformName: string;
  /** Example identifiers for tool descriptions. */
  identifierExamples: string;
  /** How the directory lookup works — for tool descriptions. */
  directoryDescription: string;
}

export interface MeetingPluginOptions {
  /** OpenClaw plugin id */
  id: string;
  name: string;
  description: string;
  version: string;
  /**
   * Map of channel name → platform config.
   * Key must match ctx.messageChannel (e.g. "feishu", "slack", "telegram").
   */
  platforms: Record<string, PlatformConfig>;
}

/** @deprecated Use MeetingPluginOptions with platforms map instead. */
export interface MeetingPluginSingleOptions {
  id: string;
  name: string;
  description: string;
  version: string;
  createProvider: (cfg: Record<string, string>) => CalendarProvider;
  userIdPattern: RegExp;
  looksLikeUserId: (s: string) => boolean;
  platformName: string;
  identifierExamples: string;
  directoryDescription: string;
}

// ============================================================================
// Helpers
// ============================================================================

function asArray<T = string>(v: any): T[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.length > 0) return [v as any];
  return [];
}

function toolResult<TDetails>(
  text: string,
  details: TDetails,
): { content: { type: "text"; text: string }[]; details: TDetails } {
  return { content: [{ type: "text", text }], details };
}

// ============================================================================
// PendingMeeting store
// ============================================================================

const PENDING_TTL_MS = 12 * 60 * 60 * 1000;
const STATUS_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const TICKER_INTERVAL_MS = 60 * 1000;
const FINALIZE_DELAY_MS = 30_000;
const IDEMPOTENCY_WINDOW_MS = 60_000;

type AttendeeStatus = "pending" | "accepted" | "declined" | "proposed_alt";

interface AttendeeResponse {
  openId: string;
  /** Display name resolved during meeting creation. */
  displayName?: string;
  status: AttendeeStatus;
  proposedWindows?: { start: Date; end: Date }[];
  note?: string;
  respondedAt?: number;
}

type MeetingPhase = "collecting" | "scoring" | "confirming";

interface ScoredSlot {
  start: Date;
  end: Date;
  score: number;
  totalAttendees: number;
  availableNames: string[];
}

interface PendingMeeting {
  id: string;
  channel: string;
  initiatorOpenId: string;
  title: string;
  description?: string;
  originalWindow: { earliest: Date; latest: Date };
  durationMinutes: number;
  timezone: string;
  attendees: AttendeeResponse[];
  createdAt: number;
  expiresAt: number;
  lastStatusUpdateAt: number;
  finalEventId?: string;
  closed: boolean;
  finalizeTimer?: ReturnType<typeof setTimeout>;
  finalizeScheduledAt?: number;
  /** Negotiation phase. */
  phase: MeetingPhase;
  /** Cached scoring results for the initiator to review. */
  scoredSlots?: ScoredSlot[];
  /** The slot the initiator picked — set during confirming phase. */
  confirmedSlot?: { start: Date; end: Date };
  /** Which round of negotiation we're on. */
  negotiationRound: number;
}

const pendingMeetings = new Map<string, PendingMeeting>();
const recentFindAndBook = new Map<string, { meetingId: string; at: number }>();
const inflightFindAndBook = new Map<string, Promise<any>>();

function gcIdempotency(now: number): void {
  for (const [k, v] of recentFindAndBook) {
    if (now - v.at > IDEMPOTENCY_WINDOW_MS) recentFindAndBook.delete(k);
  }
}

function rawRequestKey(params: {
  sender: string; title: string; earliest: string; latest: string;
  duration: number; attendees: string[];
}): string {
  const sortedRaw = [...new Set(params.attendees)].sort();
  return createHash("sha256")
    .update([params.sender, params.title, params.earliest, params.latest, String(params.duration), sortedRaw.join(",")].join("|"))
    .digest("hex");
}

function newMeetingId(): string {
  return "mtg_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function gcPending(now: number): void {
  for (const [id, m] of pendingMeetings) {
    if (m.closed && now - m.createdAt > PENDING_TTL_MS) {
      if (m.finalizeTimer) { clearTimeout(m.finalizeTimer); m.finalizeTimer = undefined; }
      pendingMeetings.delete(id);
    }
  }
}

function mergeOverlappingWindows(windows: { start: Date; end: Date }[]): { start: Date; end: Date }[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].filter((w) => w.end.getTime() > w.start.getTime()).sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: { start: Date; end: Date }[] = [];
  for (const w of sorted) {
    if (out.length === 0) { out.push({ start: w.start, end: w.end }); continue; }
    const last = out[out.length - 1];
    if (w.start.getTime() <= last.end.getTime()) {
      if (w.end.getTime() > last.end.getTime()) last.end = w.end;
    } else { out.push({ start: w.start, end: w.end }); }
  }
  return out;
}

/**
 * Score candidate time slots by how many attendees are available.
 *
 * 1. Collect each non-declined attendee's available windows
 *    - accepted → entire originalWindow is available
 *    - proposed_alt → only their proposedWindows
 * 2. Build a union of ALL attendee windows (not intersection)
 * 3. Slide a window of `durationMinutes` across the union
 * 4. For each candidate slot, count how many attendees cover it fully
 * 5. Return sorted by score descending, top maxResults
 */
function scoreSlots(
  attendees: AttendeeResponse[],
  durationMinutes: number,
  originalWindow: { earliest: Date; latest: Date },
  maxResults: number = 5,
): ScoredSlot[] {
  const active = attendees.filter((a) => a.status === "accepted" || a.status === "proposed_alt");
  if (active.length === 0) return [];

  // Build per-attendee availability
  const perAttendee: { name: string; windows: { s: number; e: number }[] }[] = active.map((a) => {
    if (a.status === "accepted") {
      return { name: a.displayName || a.openId, windows: [{ s: originalWindow.earliest.getTime(), e: originalWindow.latest.getTime() }] };
    }
    return {
      name: a.displayName || a.openId,
      windows: (a.proposedWindows ?? []).map((w) => ({ s: w.start.getTime(), e: w.end.getTime() })),
    };
  });

  // Build union of ALL windows to find candidate slot positions
  const allWindows: { s: number; e: number }[] = [];
  for (const pa of perAttendee) {
    for (const w of pa.windows) allWindows.push(w);
  }
  // Sort and merge into a union
  allWindows.sort((a, b) => a.s - b.s);
  const union: { s: number; e: number }[] = [];
  for (const w of allWindows) {
    if (union.length === 0) { union.push({ ...w }); continue; }
    const last = union[union.length - 1];
    if (w.s <= last.e) { last.e = Math.max(last.e, w.e); } else { union.push({ ...w }); }
  }

  const durationMs = durationMinutes * 60 * 1000;
  const stepMs = 15 * 60 * 1000; // 15-minute step for finer granularity
  const results: ScoredSlot[] = [];

  for (const u of union) {
    for (let start = u.s; start + durationMs <= u.e; start += stepMs) {
      const end = start + durationMs;
      // Count how many attendees fully cover [start, end)
      let score = 0;
      const availableNames: string[] = [];
      for (const pa of perAttendee) {
        const covers = pa.windows.some((w) => w.s <= start && w.e >= end);
        if (covers) { score++; availableNames.push(pa.name); }
      }
      if (score > 0) {
        results.push({ start: new Date(start), end: new Date(end), score, totalAttendees: active.length, availableNames });
      }
    }
  }

  // Sort by score desc, then by earliest start
  results.sort((a, b) => b.score - a.score || a.start.getTime() - b.start.getTime());

  // Dedupe: keep only the highest-scored slot for each unique start time
  const seen = new Set<number>();
  const deduped: ScoredSlot[] = [];
  for (const r of results) {
    if (!seen.has(r.start.getTime())) { seen.add(r.start.getTime()); deduped.push(r); }
    if (deduped.length >= maxResults) break;
  }

  return deduped;
}

// ============================================================================
// Factory (supports both single-platform and multi-platform)
// ============================================================================

export function createMeetingPlugin(opts: MeetingPluginOptions | MeetingPluginSingleOptions) {
  // Normalize single-platform options to multi-platform format
  let multiOpts: MeetingPluginOptions;
  if ("platforms" in opts) {
    multiOpts = opts;
  } else {
    // Legacy single-platform format — wrap into platforms map with a wildcard key
    multiOpts = {
      id: opts.id, name: opts.name, description: opts.description, version: opts.version,
      platforms: {
        _default: {
          createProvider: opts.createProvider,
          userIdPattern: opts.userIdPattern,
          looksLikeUserId: opts.looksLikeUserId,
          platformName: opts.platformName,
          identifierExamples: opts.identifierExamples,
          directoryDescription: opts.directoryDescription,
        },
      },
    };
  }

  const plugin = {
    id: multiOpts.id,
    name: multiOpts.name,
    description: multiOpts.description,
    version: multiOpts.version,

    register(api: any) {
      const rawCfg = (api?.pluginConfig ?? api?.config ?? {}) as Record<string, string>;
      const cfg: Record<string, string> = new Proxy(rawCfg, {
        get(target, prop: string) { return target[prop] ?? process.env[prop] ?? ""; },
      });

      const rules: ScheduleRules = {
        timezone: cfg.DEFAULT_TIMEZONE || "Asia/Shanghai",
        workHours: cfg.WORK_HOURS || "09:00-18:00",
        lunchBreak: cfg.LUNCH_BREAK || "12:00-13:30",
        bufferMinutes: Number(cfg.BUFFER_MINUTES || 15),
      };

      // --- Initialize all configured providers ---
      const providers = new Map<string, CalendarProvider>();
      const platformConfigs = new Map<string, PlatformConfig>();
      for (const [channel, pcfg] of Object.entries(multiOpts.platforms)) {
        try {
          const prov = pcfg.createProvider(cfg);
          providers.set(channel, prov);
          platformConfigs.set(channel, pcfg);
          console.error(`[meeting-scheduler] provider initialized for channel="${channel}" (${pcfg.platformName})`);
        } catch (err: any) {
          console.error(`[meeting-scheduler] provider init FAILED for channel="${channel}": ${err.message}`);
        }
      }

      // --- Resolve provider + platform from context ---
      function resolveCtx(ctx: any): { channel: string; provider: CalendarProvider; pcfg: PlatformConfig } | null {
        const ch = ctx?.messageChannel as string | undefined;
        // Try exact match first
        if (ch && providers.has(ch)) {
          return { channel: ch, provider: providers.get(ch)!, pcfg: platformConfigs.get(ch)! };
        }
        // Fallback to _default (single-platform mode)
        if (providers.has("_default")) {
          return { channel: ch || "_default", provider: providers.get("_default")!, pcfg: platformConfigs.get("_default")! };
        }
        // Try first available provider as last resort
        const first = providers.entries().next();
        if (!first.done) {
          const [key, prov] = first.value;
          return { channel: key, provider: prov, pcfg: platformConfigs.get(key)! };
        }
        return null;
      }

      /** Get provider for an existing PendingMeeting (by its stored channel). */
      function providerForMeeting(m: PendingMeeting): CalendarProvider | null {
        return providers.get(m.channel) ?? null;
      }

      function normalizeAttendees(list: string[], pcfg: PlatformConfig): string[] {
        const out = new Set<string>();
        for (const raw of list) {
          if (!raw || typeof raw !== "string") continue;
          const v = raw.trim();
          if (!v) continue;
          if (pcfg.looksLikeUserId(v)) {
            if (pcfg.userIdPattern.test(v)) out.add(v);
            continue;
          }
          out.add(v);
        }
        return Array.from(out);
      }

      // --- Date/time helpers ---

      function currentDateHint(): string {
        const zone = rules.timezone;
        const formatYMD = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
        const weekdayOf = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(d);
        const now = new Date();
        const oneDay = 86400 * 1000;
        const lines: string[] = [];
        lines.push(`today       = ${formatYMD(now)} (${weekdayOf(now)})`);
        for (let i = 1; i <= 7; i++) {
          const d = new Date(now.getTime() + i * oneDay);
          const tag = i === 1 ? "tomorrow   " : i === 2 ? "day-after  " : `+${i} days    `;
          lines.push(`${tag} = ${formatYMD(d)} (${weekdayOf(d)})`);
        }
        return `Timezone=${zone}. Use these EXACT dates:\n` + lines.map((l) => "  " + l).join("\n") +
          "\nChinese mapping: 今天→today, 明天→tomorrow, 后天→day-after, 下周X→pick the row whose weekday matches X.";
      }

      function fmtLocal(d: Date): string {
        return new Intl.DateTimeFormat("zh-CN", { timeZone: rules.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
      }

      async function resolveAll(provider: CalendarProvider, queries: string[]): Promise<{ resolved: ResolvedUser[]; ids: string[]; unresolved: string[] }> {
        if (queries.length === 0) return { resolved: [], ids: [], unresolved: [] };
        const resolved = await provider.resolveUsers(queries);
        const ids: string[] = [];
        const unresolved: string[] = [];
        for (const r of resolved) { if (r.userId) ids.push(r.userId); else unresolved.push(r.query); }
        return { resolved, ids, unresolved };
      }

      async function safeDM(provider: CalendarProvider, userId: string, text: string): Promise<void> {
        if (typeof provider.sendTextDM !== "function") return;
        try { await provider.sendTextDM(userId, text); }
        catch (err) { console.error(`[meeting-scheduler] sendTextDM failed for ${userId}: ${String(err)}`); }
      }

      function buildResponseRollCall(m: PendingMeeting): string {
        const lines: string[] = [];
        for (const a of m.attendees) {
          const name = a.displayName || a.openId;
          const tag = a.status === "accepted" ? "✓ 已接受"
            : a.status === "declined" ? "✗ 已拒绝"
            : a.status === "proposed_alt" ? `~ 建议改时间 (${(a.proposedWindows ?? []).map((w) => `${fmtLocal(w.start)}–${fmtLocal(w.end)}`).join(", ")})`
            : "… 未回复";
          lines.push(`- ${name}: ${tag}` + (a.note ? `  // ${a.note}` : ""));
        }
        return lines.join("\n");
      }

      // --- Finalize ---

      /**
       * Create the calendar event (or report) for a confirmed slot.
       * Called when all attendees accepted in the confirming phase, or
       * in the fast path (all accepted in collecting phase).
       */
      async function commitMeeting(m: PendingMeeting, slot: { start: Date; end: Date }): Promise<string> {
        const provider = providerForMeeting(m);
        if (!provider) { m.closed = true; return "No provider."; }

        const finalAttendees = m.attendees.filter((a) => a.status === "accepted" || a.status === "proposed_alt").map((a) => a.openId);
        const declined = m.attendees.filter((a) => a.status === "declined");

        try {
          const event = await provider.createEvent({ title: m.title, description: m.description, start: slot.start, end: slot.end, attendees: finalAttendees, timezone: m.timezone });
          m.finalEventId = event.id; m.closed = true;
          const summary = `已为《${m.title}》锁定时间: ${fmtLocal(slot.start)} – ${fmtLocal(slot.end)}。\n` +
            `最终参会人 (${finalAttendees.length}): 已发送日历邀请。\n` +
            (declined.length > 0 ? `拒绝: ${declined.length} 人。\n` : "") +
            (event.joinUrl ? `会议链接: ${event.joinUrl}` : "");
          await safeDM(provider, m.initiatorOpenId, summary);
          return summary;
        } catch {
          m.closed = true;
          const summary = `会议《${m.title}》已确定时间:\n` +
            `📅 ${fmtLocal(slot.start)} – ${fmtLocal(slot.end)}\n` +
            `参会人 (${finalAttendees.length}):\n` + buildResponseRollCall(m) +
            (declined.length > 0 ? `\n拒绝: ${declined.length} 人` : "") +
            `\n\n⚠️ 日历后端未配置，请手动创建日历事件。`;
          await safeDM(provider, m.initiatorOpenId, summary);
          return summary;
        }
      }

      async function finaliseMeeting(m: PendingMeeting): Promise<string> {
        const provider = providerForMeeting(m);
        if (!provider) { m.closed = true; return "No provider for this meeting's channel."; }

        console.error(`[meeting-scheduler] finaliseMeeting ENTER meetingId=${m.id} phase=${m.phase} round=${m.negotiationRound}`);
        if (m.closed) return "Meeting already closed.";
        if (m.finalizeTimer) { clearTimeout(m.finalizeTimer); m.finalizeTimer = undefined; }

        const acceptedOrAlt = m.attendees.filter((a) => a.status === "accepted" || a.status === "proposed_alt");
        const declined = m.attendees.filter((a) => a.status === "declined");
        const declinedNames = declined.map((a) => a.displayName || a.openId);

        if (acceptedOrAlt.length === 0) {
          m.closed = true;
          const text = `会议《${m.title}》无法成立: 所有受邀人都已拒绝或未回复。`;
          await safeDM(provider, m.initiatorOpenId, text);
          return text;
        }

        // --- CONFIRMING phase: all responded to confirmation round ---
        if (m.phase === "confirming" && m.confirmedSlot) {
          const hasProposedAlt = acceptedOrAlt.some((a) => a.status === "proposed_alt");
          if (!hasProposedAlt) {
            // Everyone accepted the confirmed slot → commit!
            return commitMeeting(m, m.confirmedSlot);
          }
          // Some people proposed_alt in the confirmation round → re-score
          console.error(`[meeting-scheduler] confirmation round had proposed_alt, re-scoring`);
          // Fall through to scoring below
        }

        // --- FAST PATH: all accepted (no proposed_alt) → commit directly ---
        const allAccepted = acceptedOrAlt.every((a) => a.status === "accepted");
        if (allAccepted && m.phase === "collecting") {
          // Everyone accepted the original window — pick the first available slot
          const perAtt: Window[][] = acceptedOrAlt.map(() => [{ start: m.originalWindow.earliest, end: m.originalWindow.latest }]);
          const initial: Window[] = [{ start: m.originalWindow.earliest, end: m.originalWindow.latest }];
          const intersected = intersectManyWindows(initial, perAtt);
          const slots = findSlotsInWindows(intersected, m.durationMinutes, rules);
          if (slots.length > 0) {
            return commitMeeting(m, slots[0]);
          }
        }

        // --- SCORING PATH: some proposed_alt → score and present to initiator ---
        const scored = scoreSlots(m.attendees, m.durationMinutes, m.originalWindow);
        console.error(`[meeting-scheduler] scored ${scored.length} slots, top=${scored[0]?.score ?? 0}`);

        if (scored.length === 0) {
          m.closed = true;
          const text = `会议《${m.title}》无法找到任何可用时段（${m.durationMinutes}分钟）。\n` + buildResponseRollCall(m);
          await safeDM(provider, m.initiatorOpenId, text);
          return text;
        }

        // Store scores and move to scoring phase
        m.scoredSlots = scored;
        m.phase = "scoring";
        m.negotiationRound++;

        // Build the scoring report for the initiator
        const totalNonDeclined = m.attendees.length - declined.length;
        const slotLines = scored.map((s, i) => {
          const star = i === 0 ? " ⭐" : "";
          return `${i + 1}. ${fmtLocal(s.start)} – ${fmtLocal(s.end)}  — ${s.score}/${totalNonDeclined} 人可参加${star}`;
        });
        const report =
          `会议《${m.title}》第${m.negotiationRound}轮协商，以下是时间段打分（满分${totalNonDeclined}）:\n\n` +
          `📊 排名:\n${slotLines.join("\n")}\n\n` +
          (declined.length > 0 ? `拒绝参加: ${declinedNames.join("、")}\n\n` : "") +
          `请回复选择:\n` +
          `- "选 1" / "就第一个" → 选择排名第1的时间段\n` +
          `- "改成 04/14 16:00-17:00" → 自定义时间\n` +
          `- "取消会议" → 放弃`;

        await safeDM(provider, m.initiatorOpenId, report);

        // Return scoring details to the LLM (tool result)
        return report;
      }

      function scheduleFinalize(m: PendingMeeting): void {
        if (m.closed) return;
        if (m.finalizeTimer) { clearTimeout(m.finalizeTimer); m.finalizeTimer = undefined; }
        m.finalizeScheduledAt = Date.now() + FINALIZE_DELAY_MS;
        m.finalizeTimer = setTimeout(async () => {
          m.finalizeTimer = undefined;
          if (m.closed) return;
          if (m.attendees.filter((a) => a.status === "pending").length > 0) return;
          try { await finaliseMeeting(m); } catch (err) { console.error(`[meeting-scheduler] delayed finalize failed: ${err}`); }
        }, FINALIZE_DELAY_MS);
      }

      // --- Background ticker ---
      const tickerHandle = setInterval(async () => {
        const now = Date.now();
        gcPending(now);
        for (const m of Array.from(pendingMeetings.values())) {
          if (m.closed) continue;
          const provider = providerForMeeting(m);
          if (!provider) continue;

          if (now >= m.expiresAt) {
            m.closed = true;
            if (m.finalizeTimer) { clearTimeout(m.finalizeTimer); m.finalizeTimer = undefined; }
            await safeDM(provider, m.initiatorOpenId,
              `会议《${m.title}》已超过 12 小时仍未收齐回复，已自动取消。\n` + buildResponseRollCall(m) + `\n如需继续，请重新发起。`);
            continue;
          }

          const lastUpdate = m.lastStatusUpdateAt || m.createdAt;
          if (now - lastUpdate >= STATUS_UPDATE_INTERVAL_MS) {
            const pendingCount = m.attendees.filter((a) => a.status === "pending").length;
            const repliedCount = m.attendees.length - pendingCount;
            await safeDM(provider, m.initiatorOpenId,
              `《${m.title}》状态更新 (${repliedCount}/${m.attendees.length} 已回复):\n` + buildResponseRollCall(m) +
              `\n剩余等待时间: ${Math.max(0, Math.round((m.expiresAt - now) / 60000))} 分钟。`);
            m.lastStatusUpdateAt = now;
          }
        }
      }, TICKER_INTERVAL_MS);
      void tickerHandle;

      // --- Build platform description for tool descriptions ---
      const platformNames = Array.from(platformConfigs.values()).map((p) => p.platformName);
      const platformLabel = platformNames.join(" / ") || "IM";
      const allIdentifierExamples = Array.from(platformConfigs.values()).map((p) => p.identifierExamples).join("; or ");
      const allDirectoryDesc = Array.from(platformConfigs.values()).map((p) => `${p.platformName}: ${p.directoryDescription}`).join("; ");

      // =======================================================================
      // Tool 1: find_and_book_meeting
      // =======================================================================
      api.registerTool((ctx: any) => {
        const senderOpenId: string | undefined = ctx?.requesterSenderId;
        const resolved = resolveCtx(ctx);

        return {
          name: "find_and_book_meeting",
          label: "Find and book meeting",
          description:
            "🚨 MANDATORY TOOL — DO NOT IGNORE 🚨\n\n" +
            "If the user's message contains ANY intent to schedule a meeting, you MUST call this tool.\n" +
            "Triggers: schedule/arrange/book a meeting / 约会议 / 帮我约 / 安排会议 / 开个会\n\n" +
            `Current date table:\n${currentDateHint()}\n\n` +
            `Platforms: ${platformLabel}. Attendee formats: ${allIdentifierExamples}\n\n` +
            "WORKFLOW: creates pending meeting → DMs attendees → auto-finalizes.\n" +
            "TWO-STEP NAME RESOLUTION: if unresolved, RE-INVOKE with the user ID from candidates.\n" +
            "NEVER claim 'confirmed' — only PENDING until finalized.",
          parameters: {
            type: "object", additionalProperties: false,
            properties: {
              title: { type: "string", description: "Meeting title" },
              description: { type: "string", description: "Optional agenda" },
              required_attendees: { type: "array", items: { type: "string" }, minItems: 1, description: "Attendee identifiers — pass VERBATIM." },
              duration_minutes: { type: "number", default: 30 },
              earliest: { type: "string", description: "RFC3339 with timezone" },
              latest: { type: "string", description: "RFC3339 with timezone" },
            },
            required: ["title", "required_attendees", "earliest", "latest"],
          } as any,

          execute: async (_toolCallId: string, params: any) => {
            const p = params ?? {};
            const t0 = Date.now();
            const trace = (step: string) => console.error(`[meeting-scheduler] ${step} (+${Date.now() - t0}ms)`);

            if (!senderOpenId) return toolResult("No trusted sender id.", { ok: false, reason: "no_sender" });
            if (!resolved) return toolResult("No provider configured for this channel.", { ok: false, reason: "no_provider" });
            const { channel, provider, pcfg } = resolved;

            // --- Guard: block attendees who have pending invitations ---
            // If the sender is an attendee (not initiator) of an open meeting
            // with status "pending", they should be responding to that invitation
            // instead of creating a new meeting.
            for (const m of pendingMeetings.values()) {
              if (m.closed) continue;
              if (m.initiatorOpenId === senderOpenId) continue; // initiators CAN create new meetings
              const myEntry = m.attendees.find((a) => a.openId === senderOpenId && a.status === "pending");
              if (myEntry) {
                console.error(`[meeting-scheduler] find_and_book_meeting BLOCKED: sender=${senderOpenId} has pending invitation for meeting=${m.id}`);
                return toolResult(
                  `你有一个待回复的会议邀请《${m.title}》(id=${m.id})，请先回复该邀请。\n` +
                  `请使用 record_attendee_response 来接受、拒绝或提出替代时间。\n` +
                  `如果你确实想发起一个全新的会议，请先处理待定邀请。`,
                  { ok: false, reason: "has_pending_invitation", pendingMeetingId: m.id, pendingMeetingTitle: m.title },
                );
              }
            }

            // In-flight dedup
            const inflightKey = rawRequestKey({ sender: senderOpenId, title: String(p.title ?? ""), earliest: String(p.earliest ?? ""), latest: String(p.latest ?? ""), duration: Number(p.duration_minutes ?? 30), attendees: asArray<string>(p.required_attendees) });
            const existingP = inflightFindAndBook.get(inflightKey);
            if (existingP) { try { return await existingP; } catch { /* retry */ } }

            const workPromise = (async () => {
            try {
            let requiredQ = normalizeAttendees(asArray<string>(p.required_attendees), pcfg);
            if (!requiredQ.includes(senderOpenId)) requiredQ = [senderOpenId, ...requiredQ];
            trace(`normalized attendees: ${JSON.stringify(requiredQ)}`);

            const reqResolved = await resolveAll(provider, requiredQ);
            trace(`resolveAll done ids=${reqResolved.ids.length} unresolved=${JSON.stringify(reqResolved.unresolved)}`);

            if (reqResolved.unresolved.length > 0) {
              const candSet = new Map<string, any>();
              for (const e of reqResolved.resolved.filter((r) => !r.userId && r.candidates?.length)) {
                for (const c of e.candidates ?? []) { if (!candSet.has(c.userId)) candSet.set(c.userId, c); }
              }
              const candList = Array.from(candSet.values());
              const candLines = candList.map((c, i) => `${i + 1}. ${[c.name, c.en_name, c.nickname, c.email].filter(Boolean).join(" / ")}  → user_id=${c.userId}`);
              return toolResult(
                "Some attendees could not be resolved: " + JSON.stringify(reqResolved.unresolved) +
                ".\n\nPICK the user and RE-INVOKE with their user ID.\n\nCandidates:\n" + candLines.join("\n"),
                { ok: false, reason: "unresolved_names", unresolved: reqResolved.unresolved, candidates: candList },
              );
            }

            if (reqResolved.ids.length === 0) return toolResult("Could not resolve any attendees.", { ok: false, reason: "unresolved" });

            const earliest = new Date(p.earliest); const latest = new Date(p.latest);
            if (isNaN(earliest.getTime()) || isNaN(latest.getTime()) || earliest >= latest) return toolResult("Invalid time window.", { ok: false, reason: "bad_window" });

            const durationMinutes = Number(p.duration_minutes ?? 30);
            const now = Date.now();
            gcIdempotency(now);
            const idemKey = createHash("sha256").update([senderOpenId, String(p.title), earliest.toISOString(), latest.toISOString(), String(durationMinutes), [...reqResolved.ids].sort().join(",")].join("|")).digest("hex");
            const prior = recentFindAndBook.get(idemKey);
            if (prior) { const em = pendingMeetings.get(prior.meetingId); if (em && !em.closed) return toolResult(`Duplicate. Reusing ${prior.meetingId}.`, { ok: true, duplicate: true, meetingId: prior.meetingId }); }

            const meetingId = newMeetingId();
            recentFindAndBook.set(idemKey, { meetingId, at: now });
            const meeting: PendingMeeting = {
              id: meetingId, channel, initiatorOpenId: senderOpenId,
              title: String(p.title), description: p.description ? String(p.description) : undefined,
              originalWindow: { earliest, latest }, durationMinutes, timezone: rules.timezone,
              attendees: reqResolved.ids.map((uid) => {
                const resolved = reqResolved.resolved.find((r) => r.userId === uid);
                return { openId: uid, displayName: resolved?.name || undefined, status: uid === senderOpenId ? "accepted" as const : "pending" as const, respondedAt: uid === senderOpenId ? now : undefined };
              }),
              createdAt: now, expiresAt: now + PENDING_TTL_MS, lastStatusUpdateAt: now, closed: false,
              phase: "collecting", negotiationRound: 0,
            };
            pendingMeetings.set(meetingId, meeting);

            const inviteText = `您收到一个会议邀请: 《${meeting.title}》\n` +
              (meeting.description ? `说明: ${meeting.description}\n` : "") +
              `初步时间范围: ${fmtLocal(earliest)} – ${fmtLocal(latest)}\n时长: ${durationMinutes} 分钟\n` +
              `\n请直接回复我:\n  - 同意: "接受" / "同意" / "可以"\n  - 只在某段时间有空: "我只有明天 13:00-14:00 有空"\n  - 拒绝: "拒绝" / "不行"\n\n超过 12 小时未回复将自动取消。`;

            const sent: string[] = []; const failed: string[] = [];
            for (const a of meeting.attendees) {
              if (a.openId === senderOpenId) continue;
              try { if (typeof provider.sendTextDM !== "function") throw new Error("sendTextDM not implemented"); await provider.sendTextDM(a.openId, inviteText); sent.push(a.openId); }
              catch (err) { failed.push(a.openId); console.error(`[meeting-scheduler] invite DM FAILED for ${a.openId}: ${(err as any)?.message}`); }
            }

            return toolResult(
              `已创建待定会议《${meeting.title}》(id=${meetingId})。已向 ${sent.length} 位参会人发送邀请` +
              (failed.length > 0 ? `，${failed.length} 人失败` : "") + `，等待回复中。`,
              { ok: true, meetingId, attendeeCount: meeting.attendees.length, dispatched: sent.length, failedDispatch: failed, expiresAt: new Date(meeting.expiresAt).toISOString() },
            );
            } catch (err: any) { return toolResult(`Internal error: ${err?.message}`, { ok: false, reason: "exception" }); }
            })();
            inflightFindAndBook.set(inflightKey, workPromise);
            try { return await workPromise; } finally { inflightFindAndBook.delete(inflightKey); }
          },
        };
      });

      // =======================================================================
      // Tool 2: list_my_pending_invitations
      // =======================================================================
      api.registerTool((ctx: any) => {
        const senderOpenId: string | undefined = ctx?.requesterSenderId;
        return {
          name: "list_my_pending_invitations",
          label: "List my pending meeting invitations",
          description: "Look up pending meeting invitations for the current sender.",
          parameters: { type: "object", additionalProperties: false, properties: {} } as any,
          execute: async () => {
            if (!senderOpenId) return toolResult("No sender.", { ok: false, meetings: [] });
            const matches: any[] = [];
            for (const m of pendingMeetings.values()) {
              if (m.closed) continue;
              if (m.attendees.find((a) => a.openId === senderOpenId && a.status === "pending")) {
                matches.push({ meetingId: m.id, title: m.title, originalWindow: { earliestLocal: fmtLocal(m.originalWindow.earliest), latestLocal: fmtLocal(m.originalWindow.latest) }, durationMinutes: m.durationMinutes });
              }
            }
            return toolResult(`Found ${matches.length} pending invitation(s).`, { ok: true, meetings: matches });
          },
        };
      });

      // =======================================================================
      // Tool 3: record_attendee_response
      // =======================================================================
      api.registerTool((ctx: any) => {
        const senderOpenId: string | undefined = ctx?.requesterSenderId;
        const resolved = resolveCtx(ctx);
        return {
          name: "record_attendee_response",
          label: "Record attendee response",
          description:
            "Record an attendee's response to a pending meeting invitation.\n\n" +
            "WHEN TO CALL: If the user's message sounds like a reply to a meeting invite, " +
            "call this tool DIRECTLY. Omit meetingId to auto-resolve.\n\n" +
            "STATUS MAPPING:\n" +
            "  - 接受/同意/可以/行/好 → status='accepted'\n" +
            "  - 拒绝/不行/不能/没空 → status='declined'\n" +
            "  - 具体时间段 → status='proposed_alt' + proposed_windows\n" +
            "  - '让XXX替我去' / '让XXX代替' → status='delegated' + delegateTo='XXX'\n" +
            "    IMPORTANT: When user says '让家乐替我去', you MUST first ask:\n" +
            "    '你确认家乐已经同意代替你参加吗？' If user confirms yes, THEN call\n" +
            "    this tool with status='delegated'. If user says no/unsure, tell\n" +
            "    them to get agreement first.\n\n" +
            `Date table:\n${currentDateHint()}\n\n` +
            "MODE: append (default) vs replace (only on explicit correction).",
          parameters: {
            type: "object", additionalProperties: false,
            properties: {
              meetingId: { type: "string", description: "Optional — auto-resolves if omitted." },
              status: { type: "string", enum: ["accepted", "declined", "proposed_alt", "delegated"], description: "Use 'delegated' when attendee wants someone else to attend in their place." },
              proposed_windows: { type: "array", items: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } }, required: ["start", "end"] } },
              mode: { type: "string", enum: ["append", "replace"], default: "append" },
              note: { type: "string" },
              delegateTo: { type: "string", description: "Name/email/userId of the substitute person. Required when status='delegated'." },
            },
            required: ["status"],
          } as any,
          execute: async (_toolCallId: string, params: any) => {
            const p = params ?? {};
            if (!senderOpenId) return toolResult("No sender.", { ok: false, reason: "no_sender" });

            let meetingId: string | undefined = p.meetingId;
            let meeting: PendingMeeting | undefined;
            if (!meetingId) {
              const cands: PendingMeeting[] = [];
              for (const m of pendingMeetings.values()) { if (!m.closed && m.attendees.find((a) => a.openId === senderOpenId)) cands.push(m); }
              if (cands.length === 0) return toolResult("No pending invitation.", { ok: false, reason: "no_pending" });
              if (cands.length > 1) return toolResult(`${cands.length} pending invitations — specify meetingId.`, { ok: false, reason: "ambiguous", meetings: cands.map((c) => ({ meetingId: c.id, title: c.title })) });
              meeting = cands[0]; meetingId = meeting.id;
            } else { meeting = pendingMeetings.get(meetingId); }

            if (!meeting || meeting.closed) return toolResult("Meeting not found or closed.", { ok: false, reason: "not_found" });
            const entry = meeting.attendees.find((a) => a.openId === senderOpenId);
            if (!entry) return toolResult("Not on attendee list.", { ok: false, reason: "not_invited" });

            const status = p.status as string;

            // --- DELEGATION ---
            if (status === "delegated") {
              const delegateName = p.delegateTo?.trim();
              if (!delegateName) {
                return toolResult("status='delegated' 需要 delegateTo 参数（替代人的姓名/邮箱/ID）。", { ok: false, reason: "no_delegate" });
              }
              if (!resolved) return toolResult("No provider.", { ok: false, reason: "no_provider" });
              const { provider } = resolved;

              // Mark original attendee as declined
              entry.status = "declined";
              entry.proposedWindows = undefined;
              entry.note = (entry.note ? entry.note + "\n" : "") + `委托给: ${delegateName}`;
              entry.respondedAt = Date.now();

              // Resolve the delegate
              console.error(`[meeting-scheduler] delegation: ${senderOpenId} → ${delegateName}`);
              const delegateResolved = await resolveAll(provider, [delegateName]);

              if (delegateResolved.unresolved.length > 0 && delegateResolved.resolved[0]?.candidates) {
                // Unresolved name — return candidates for LLM to pick
                const candList = delegateResolved.resolved[0].candidates;
                const candLines = candList!.map((c, i) => `${i + 1}. ${[c.name, c.en_name, c.email].filter(Boolean).join(" / ")} → user_id=${c.userId}`);
                return toolResult(
                  `无法精确找到 "${delegateName}"。请从以下候选中选择正确的人，然后用其 user_id 重新调用:\n` +
                  candLines.join("\n"),
                  { ok: false, reason: "unresolved_delegate", candidates: candList },
                );
              }

              if (delegateResolved.ids.length === 0) {
                return toolResult(`无法找到用户 "${delegateName}"。请确认姓名/邮箱是否正确。`, { ok: false, reason: "delegate_not_found" });
              }

              const delegateId = delegateResolved.ids[0];
              const delegateDisplayName = delegateResolved.resolved.find((r) => r.userId === delegateId)?.name || delegateName;

              // Check if delegate is already in the meeting
              const existingDelegate = meeting.attendees.find((a) => a.openId === delegateId);
              if (existingDelegate) {
                return toolResult(
                  `${delegateDisplayName} 已经在参会人列表中（状态: ${existingDelegate.status}）。` +
                  `已将 ${entry.displayName || senderOpenId} 标记为拒绝。`,
                  { ok: true, delegated: true, delegateAlreadyInMeeting: true, meetingId: meeting.id },
                );
              }

              // Add delegate as new attendee
              meeting.attendees.push({
                openId: delegateId,
                displayName: delegateDisplayName,
                status: "pending",
              });

              // Send invitation DM to the delegate
              const inviteText =
                `您收到一个会议邀请（由 ${entry.displayName || senderOpenId} 委托）: 《${meeting.title}》\n` +
                `初步时间范围: ${fmtLocal(meeting.originalWindow.earliest)} – ${fmtLocal(meeting.originalWindow.latest)}\n` +
                `时长: ${meeting.durationMinutes} 分钟\n\n` +
                `请直接回复我:\n` +
                `  - 同意: "接受" / "同意" / "可以"\n` +
                `  - 只在某段时间有空: "我只有明天 13:00-14:00 有空"\n` +
                `  - 拒绝: "拒绝" / "不行"\n\n` +
                `超过 12 小时未回复将自动取消。`;

              try {
                if (typeof provider.sendTextDM === "function") {
                  await provider.sendTextDM(delegateId, inviteText);
                  console.error(`[meeting-scheduler] delegation DM sent to ${delegateId} (${delegateDisplayName})`);
                }
              } catch (err) {
                console.error(`[meeting-scheduler] delegation DM FAILED for ${delegateId}: ${(err as any)?.message}`);
              }

              // Notify initiator
              const initiatorProvider = providerForMeeting(meeting);
              if (initiatorProvider) {
                await safeDM(initiatorProvider, meeting.initiatorOpenId,
                  `${entry.displayName || senderOpenId} 拒绝参加《${meeting.title}》，已委托 ${delegateDisplayName} 代替参加。\n已向 ${delegateDisplayName} 发送邀请。`);
              }

              const pendingCount = meeting.attendees.filter((a) => a.status === "pending").length;
              return toolResult(
                `已记录委托: ${entry.displayName || senderOpenId} → ${delegateDisplayName}。` +
                `已向 ${delegateDisplayName} 发送邀请DM。${pendingCount} 人待回复。`,
                { ok: true, delegated: true, delegateId, delegateName: delegateDisplayName, meetingId: meeting.id, remaining: pendingCount },
              );
            }

            // --- Normal response (accepted / declined / proposed_alt) ---
            if (!["accepted", "declined", "proposed_alt"].includes(status)) return toolResult("Invalid status.", { ok: false, reason: "bad_status" });
            const mode: "append" | "replace" = p.mode === "replace" ? "replace" : "append";

            const previous = { status: entry.status, proposedWindows: (entry.proposedWindows ?? []).map((w) => ({ start: w.start.toISOString(), end: w.end.toISOString() })) };

            let newWindows: { start: Date; end: Date }[] = [];
            if (status === "proposed_alt") {
              newWindows = (Array.isArray(p.proposed_windows) ? p.proposed_windows : [])
                .map((w: any) => ({ start: new Date(w?.start), end: new Date(w?.end) }))
                .filter((w: any) => !isNaN(w.start.getTime()) && !isNaN(w.end.getTime()) && w.end > w.start);
              if (newWindows.length === 0) return toolResult("proposed_alt requires valid windows.", { ok: false, reason: "no_windows" });
            }

            if (mode === "replace") { entry.status = status as AttendeeStatus; entry.proposedWindows = status === "proposed_alt" ? newWindows : undefined; }
            else {
              if (status === "declined") { entry.status = "declined"; entry.proposedWindows = undefined; }
              else if (status === "accepted") { entry.status = "accepted"; entry.proposedWindows = undefined; }
              else { entry.proposedWindows = mergeOverlappingWindows([...(entry.proposedWindows ?? []), ...newWindows]); entry.status = "proposed_alt"; }
            }
            if (p.note) entry.note = entry.note ? `${entry.note}\n${p.note}` : String(p.note);
            entry.respondedAt = Date.now();

            const pendingCount = meeting.attendees.filter((a) => a.status === "pending").length;
            if (pendingCount === 0) {
              scheduleFinalize(meeting);
              return toolResult(`Recorded (${entry.status}). All responded — finalizing in ${Math.round(FINALIZE_DELAY_MS / 1000)}s.`, { ok: true, allResponded: true, meetingId: meeting.id, previous });
            }
            return toolResult(`Recorded (${entry.status}). ${pendingCount} pending.`, { ok: true, allResponded: false, remaining: pendingCount, meetingId: meeting.id, previous });
          },
        };
      });

      // =======================================================================
      // Tool 4: list_upcoming_meetings
      // =======================================================================
      api.registerTool((ctx: any) => {
        const resolved = resolveCtx(ctx);
        return {
          name: "list_upcoming_meetings", label: "List upcoming meetings",
          description: "List meetings on the calendar within the next N hours.",
          parameters: { type: "object", additionalProperties: false, properties: { hours: { type: "number", default: 24 } } } as any,
          execute: async (_tid: string, params: any) => {
            if (!resolved) return toolResult("No provider.", { ok: false });
            try { const events = await resolved.provider.listUpcoming("organizer", params?.hours ?? 24); return toolResult(`${events.length} upcoming.`, { ok: true, events }); }
            catch (err: any) { return toolResult(`Failed: ${err?.message}`, { ok: false }); }
          },
        };
      });

      // =======================================================================
      // Tool 5: cancel_meeting
      // =======================================================================
      api.registerTool((ctx: any) => {
        const resolved = resolveCtx(ctx);
        return {
          name: "cancel_meeting", label: "Cancel meeting",
          description: "Cancel a meeting by event id.",
          parameters: { type: "object", additionalProperties: false, properties: { eventId: { type: "string" } }, required: ["eventId"] } as any,
          execute: async (_tid: string, params: any) => {
            if (!resolved) return toolResult("No provider.", { ok: false });
            try { await resolved.provider.cancelEvent(params.eventId); return toolResult(`Cancelled.`, { ok: true }); }
            catch (err: any) { return toolResult(`Failed: ${err?.message}`, { ok: false }); }
          },
        };
      });

      // =======================================================================
      // Tool 6: confirm_meeting_slot (initiator picks a slot after scoring)
      // =======================================================================
      api.registerTool((ctx: any) => {
        const senderOpenId: string | undefined = ctx?.requesterSenderId;
        const resolved = resolveCtx(ctx);
        return {
          name: "confirm_meeting_slot",
          label: "Confirm meeting time slot",
          description:
            "Called by the initiator AFTER receiving the scoring report. " +
            "The initiator picks a time slot (by rank number or custom time), " +
            "and this tool sends a confirmation request to all attendees.\n\n" +
            "WHEN TO CALL: When the initiator replies with '选1', '就第一个', " +
            "or specifies a custom time like '改成 04/14 16:00-17:00'.\n\n" +
            "Parameters:\n" +
            "- meetingId: optional, auto-resolves if the initiator has only one meeting in scoring phase\n" +
            "- slotIndex: 1-based index from the scoring report (e.g. 1 = top ranked)\n" +
            "- OR customStart + customEnd: RFC3339 for a custom time\n" +
            "- cancel: set to true to cancel the meeting entirely",
          parameters: {
            type: "object", additionalProperties: false,
            properties: {
              meetingId: { type: "string", description: "Optional — auto-resolves." },
              slotIndex: { type: "number", description: "1-based rank from the scoring report." },
              customStart: { type: "string", description: "RFC3339 custom start time." },
              customEnd: { type: "string", description: "RFC3339 custom end time." },
              cancel: { type: "boolean", description: "Set true to cancel the meeting." },
            },
          } as any,
          execute: async (_tid: string, params: any) => {
            const p = params ?? {};
            if (!senderOpenId) return toolResult("No sender.", { ok: false, reason: "no_sender" });
            if (!resolved) return toolResult("No provider.", { ok: false, reason: "no_provider" });
            const { provider } = resolved;

            // Resolve meeting
            let meetingId: string | undefined = p.meetingId;
            let meeting: PendingMeeting | undefined;
            if (!meetingId) {
              const cands: PendingMeeting[] = [];
              for (const m of pendingMeetings.values()) {
                if (!m.closed && m.initiatorOpenId === senderOpenId && (m.phase === "scoring" || m.phase === "confirming")) {
                  cands.push(m);
                }
              }
              if (cands.length === 0) return toolResult("No meeting in scoring/confirming phase found for you.", { ok: false, reason: "no_scoring" });
              if (cands.length > 1) return toolResult(`${cands.length} meetings in scoring phase — specify meetingId.`, { ok: false, reason: "ambiguous" });
              meeting = cands[0]; meetingId = meeting.id;
            } else {
              meeting = pendingMeetings.get(meetingId);
            }

            if (!meeting || meeting.closed) return toolResult("Meeting not found or closed.", { ok: false, reason: "not_found" });
            if (meeting.initiatorOpenId !== senderOpenId) return toolResult("Only the meeting initiator can confirm.", { ok: false, reason: "not_initiator" });

            // Cancel?
            if (p.cancel) {
              meeting.closed = true;
              const text = `会议《${meeting.title}》已被发起者取消。`;
              // Notify all attendees
              for (const a of meeting.attendees) {
                if (a.openId !== senderOpenId) await safeDM(provider, a.openId, text);
              }
              return toolResult(text, { ok: true, cancelled: true });
            }

            // Determine the chosen slot
            let chosenSlot: { start: Date; end: Date } | null = null;

            if (p.slotIndex && meeting.scoredSlots && meeting.scoredSlots.length > 0) {
              const idx = Math.floor(Number(p.slotIndex)) - 1;
              if (idx >= 0 && idx < meeting.scoredSlots.length) {
                const s = meeting.scoredSlots[idx];
                chosenSlot = { start: s.start, end: s.end };
              } else {
                return toolResult(`Invalid slotIndex ${p.slotIndex}. Valid: 1-${meeting.scoredSlots.length}.`, { ok: false, reason: "bad_index" });
              }
            } else if (p.customStart && p.customEnd) {
              const s = new Date(p.customStart);
              const e = new Date(p.customEnd);
              if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) {
                return toolResult("Invalid custom time range.", { ok: false, reason: "bad_custom" });
              }
              chosenSlot = { start: s, end: e };
            }

            if (!chosenSlot) {
              return toolResult("Please provide slotIndex (1-based) or customStart+customEnd.", { ok: false, reason: "no_slot" });
            }

            // Move to confirming phase
            meeting.phase = "confirming";
            meeting.confirmedSlot = chosenSlot;

            // Reset all non-initiator attendees to pending for confirmation
            for (const a of meeting.attendees) {
              if (a.openId === meeting.initiatorOpenId) {
                a.status = "accepted";
                continue;
              }
              a.status = "pending";
              a.proposedWindows = undefined;
              a.note = undefined;
              a.respondedAt = undefined;
            }

            // Extend TTL for the new round
            meeting.expiresAt = Date.now() + PENDING_TTL_MS;
            meeting.lastStatusUpdateAt = Date.now();

            // DM all attendees with the confirmed time
            const confirmText =
              `会议《${meeting.title}》时间已更新为:\n` +
              `📅 ${fmtLocal(chosenSlot.start)} – ${fmtLocal(chosenSlot.end)}\n` +
              `时长: ${meeting.durationMinutes} 分钟\n\n` +
              `请确认是否可以参加:\n` +
              `  - "可以" / "确认" / "没问题"\n` +
              `  - "不行" / "拒绝"\n` +
              `  - 或提出新的时间段`;

            const sent: string[] = [];
            for (const a of meeting.attendees) {
              if (a.openId === meeting.initiatorOpenId) continue;
              await safeDM(provider, a.openId, confirmText);
              sent.push(a.openId);
            }

            console.error(`[meeting-scheduler] confirm_meeting_slot: meeting=${meetingId} slot=${fmtLocal(chosenSlot.start)}–${fmtLocal(chosenSlot.end)} sent=${sent.length}`);

            return toolResult(
              `已选定时间 ${fmtLocal(chosenSlot.start)} – ${fmtLocal(chosenSlot.end)}，` +
              `已向 ${sent.length} 位参会人发送确认请求。等待所有人确认。`,
              { ok: true, meetingId, confirmedSlot: { start: chosenSlot.start.toISOString(), end: chosenSlot.end.toISOString() }, sentCount: sent.length },
            );
          },
        };
      });

      // =======================================================================
      // Tool 7: debug_list_directory
      // =======================================================================
      api.registerTool((ctx: any) => {
        const resolved = resolveCtx(ctx);
        return {
          name: "debug_list_directory", label: `Debug: list directory`,
          description: `DIAGNOSTIC. Lists users in the ${platformLabel} directory. Trigger: '显示通讯录'.`,
          parameters: { type: "object", additionalProperties: false, properties: { limit: { type: "number", default: 30 } } } as any,
          execute: async (_tid: string, params: any) => {
            if (!resolved) return toolResult("No provider.", { ok: false });
            const limit = Math.max(1, Math.min(200, Number(params?.limit ?? 30)));
            try {
              const prov = resolved.provider as any;
              if (typeof prov.listAllUsers !== "function") return toolResult("Provider does not expose listAllUsers.", { ok: false });
              const users: any[] = await prov.listAllUsers();
              const rows = users.slice(0, limit).map((u: any) => ({ name: u.name ?? "", display: u.en_name ?? u.nickname ?? "", email: u.email ?? "", id: u.userId ?? u.open_id ?? "" }));
              const lines = rows.map((r: any, i: number) => `${i + 1}. name="${r.name}" display="${r.display}" email="${r.email}" id=${r.id}`);
              return toolResult(`${users.length} user(s). Showing ${rows.length}:\n` + lines.join("\n") + (users.length > rows.length ? `\n... +${users.length - rows.length} more` : ""), { ok: true, total: users.length, users: rows });
            } catch (err: any) { return toolResult(`Failed: ${err?.message}`, { ok: false }); }
          },
        };
      });
    },
  };

  return plugin;
}
