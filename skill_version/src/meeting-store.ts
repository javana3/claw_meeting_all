/**
 * In-memory + file-backed store for pending meetings.
 *
 * Persists each PendingMeeting to `pending/mtg_xxx.json` so the plugin
 * survives restarts without losing negotiation state.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Types
// ============================================================================

export type AttendeeStatus = "pending" | "accepted" | "declined" | "proposed_alt";

export interface AttendeeResponse {
  openId: string;
  /** Display name resolved during meeting creation. */
  displayName?: string;
  status: AttendeeStatus;
  proposedWindows?: { start: Date; end: Date }[];
  note?: string;
  respondedAt?: number;
}

export type MeetingPhase = "collecting" | "scoring" | "confirming";

export interface ScoredSlot {
  start: Date;
  end: Date;
  score: number;
  totalAttendees: number;
  availableNames: string[];
}

export interface PendingMeeting {
  id: string;
  /** Which platform (feishu/slack). */
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
  /** NOT persisted -- runtime-only timer handle. */
  finalizeTimer?: ReturnType<typeof setTimeout>;
  finalizeScheduledAt?: number;
  /** Negotiation phase. */
  phase: MeetingPhase;
  /** Cached scoring results for the initiator to review. */
  scoredSlots?: ScoredSlot[];
  /** The slot the initiator picked -- set during confirming phase. */
  confirmedSlot?: { start: Date; end: Date };
  /** Which round of negotiation we're on. */
  negotiationRound: number;
}

// ============================================================================
// Helper: reconstruct Date fields from parsed JSON
// ============================================================================

function rehydrateDates(raw: any): PendingMeeting {
  raw.originalWindow = {
    earliest: new Date(raw.originalWindow.earliest),
    latest: new Date(raw.originalWindow.latest),
  };

  if (Array.isArray(raw.attendees)) {
    for (const a of raw.attendees) {
      if (Array.isArray(a.proposedWindows)) {
        a.proposedWindows = a.proposedWindows.map((w: any) => ({
          start: new Date(w.start),
          end: new Date(w.end),
        }));
      }
    }
  }

  if (Array.isArray(raw.scoredSlots)) {
    raw.scoredSlots = raw.scoredSlots.map((s: any) => ({
      ...s,
      start: new Date(s.start),
      end: new Date(s.end),
    }));
  }

  if (raw.confirmedSlot) {
    raw.confirmedSlot = {
      start: new Date(raw.confirmedSlot.start),
      end: new Date(raw.confirmedSlot.end),
    };
  }

  return raw as PendingMeeting;
}

// ============================================================================
// Serialization helper: strip non-serializable fields
// ============================================================================

function toSerializable(m: PendingMeeting): Omit<PendingMeeting, "finalizeTimer"> {
  const { finalizeTimer: _, ...rest } = m;
  return rest;
}

// ============================================================================
// MeetingStore
// ============================================================================

export class MeetingStore {
  public pendingMeetings = new Map<string, PendingMeeting>();
  public recentFindAndBook = new Map<string, { meetingId: string; at: number }>();
  public inflightFindAndBook = new Map<string, Promise<any>>();

  private pendingDir: string;

  constructor(baseDir?: string) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const root = baseDir ?? path.resolve(__dirname, "..");
    this.pendingDir = path.join(root, "pending");
    fs.mkdirSync(this.pendingDir, { recursive: true });
  }

  // --------------------------------------------------------------------------
  // hydrate: scan pending/ dir on startup
  // --------------------------------------------------------------------------
  hydrate(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.pendingDir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }

    for (const file of files) {
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(this.pendingDir, file), "utf-8"),
        );
        const meeting = rehydrateDates(raw);
        this.pendingMeetings.set(meeting.id, meeting);
        console.error(`[meeting-store] hydrated ${meeting.id} from ${file}`);
      } catch (err) {
        console.error(
          `[meeting-store] failed to hydrate ${file}: ${String(
            (err as any)?.message ?? err,
          )}`,
        );
      }
    }
    console.error(
      `[meeting-store] hydration complete: ${this.pendingMeetings.size} meetings loaded`,
    );
  }

  // --------------------------------------------------------------------------
  // save: persist a single meeting to disk
  // --------------------------------------------------------------------------
  save(meetingId: string): void {
    const m = this.pendingMeetings.get(meetingId);
    if (!m) return;
    const filePath = path.join(this.pendingDir, `${meetingId}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(toSerializable(m), null, 2), "utf-8");
    } catch (err) {
      console.error(
        `[meeting-store] save ${meetingId} failed: ${String(
          (err as any)?.message ?? err,
        )}`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // remove: delete from Map and filesystem
  // --------------------------------------------------------------------------
  remove(meetingId: string): void {
    const m = this.pendingMeetings.get(meetingId);
    if (m?.finalizeTimer) {
      clearTimeout(m.finalizeTimer);
      m.finalizeTimer = undefined;
    }
    this.pendingMeetings.delete(meetingId);
    const filePath = path.join(this.pendingDir, `${meetingId}.json`);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      /* best effort */
    }
  }

  // --------------------------------------------------------------------------
  // gcPending: garbage collect expired/closed meetings
  // --------------------------------------------------------------------------
  gcPending(now: number): void {
    const PENDING_TTL_MS = 12 * 60 * 60 * 1000;
    for (const [id, m] of this.pendingMeetings) {
      if (m.closed && now - m.createdAt > PENDING_TTL_MS) {
        this.remove(id);
      }
    }
  }

  // --------------------------------------------------------------------------
  // gcIdempotency: garbage collect stale idempotency keys
  // --------------------------------------------------------------------------
  gcIdempotency(now: number): void {
    const IDEMPOTENCY_WINDOW_MS = 60_000;
    for (const [k, v] of this.recentFindAndBook) {
      if (now - v.at > IDEMPOTENCY_WINDOW_MS) this.recentFindAndBook.delete(k);
    }
  }
}
