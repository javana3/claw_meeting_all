import { DateTime } from "luxon";
import { CalendarProvider } from "./providers/types";

export interface ScheduleRules {
  timezone: string;
  workHours: string;   // "09:00-18:00"
  lunchBreak: string;  // "12:00-13:30"
  bufferMinutes: number;
}

export interface FindSlotInput {
  attendees: string[];
  durationMinutes: number;
  earliest: Date;
  latest: Date;
  rules: ScheduleRules;
}

export interface Candidate {
  start: Date;
  end: Date;
  score: number;
}

export interface SearchResult {
  candidates: Candidate[];
  /** Which fallback strategy actually produced the candidates (set by index.ts). */
  strategy?:
    | "full-attendance"
    | "required-only"
    | "extended-window"
    | "extended-required-only"
    | "none";
  /** Attendees that were dropped to find a slot (only when strategy != full-attendance). */
  droppedOptional?: string[];
  /** Final window used. */
  window?: { earliest: Date; latest: Date };
}

interface Block {
  start: number; // epoch ms
  end: number;
}

export interface Window {
  start: Date;
  end: Date;
}

/** Standard half-open interval overlap. Touching endpoints do NOT overlap. */
function overlaps(a: Block, b: Block): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Intersect two lists of half-open intervals.
 *
 * Returns the set of sub-intervals that appear in BOTH inputs. Empty result
 * means the two parties have no overlapping availability.
 *
 * Example:
 *   a = [(10:00-12:00), (14:00-16:00)]
 *   b = [(11:00-15:00)]
 *   → [(11:00-12:00), (14:00-15:00)]
 */
export function intersectWindows(a: Window[], b: Window[]): Window[] {
  const out: Window[] = [];
  for (const x of a) {
    const xs = x.start.getTime();
    const xe = x.end.getTime();
    if (xe <= xs) continue;
    for (const y of b) {
      const ys = y.start.getTime();
      const ye = y.end.getTime();
      if (ye <= ys) continue;
      const s = Math.max(xs, ys);
      const e = Math.min(xe, ye);
      if (e > s) out.push({ start: new Date(s), end: new Date(e) });
    }
  }
  return out;
}

/**
 * Intersect many attendee availability lists together.
 *
 * Starts with the `initial` window list (typically the organizer's original
 * earliest/latest range) and folds each attendee's availability into it.
 * Returns the mutual availability across everyone.
 */
export function intersectManyWindows(
  initial: Window[],
  perAttendee: Window[][],
): Window[] {
  let acc = initial;
  for (const attendee of perAttendee) {
    acc = intersectWindows(acc, attendee);
    if (acc.length === 0) return [];
  }
  return acc;
}

/**
 * Find a slot of `durationMinutes` inside the given windows, avoiding the
 * given forbidden blocks and honouring the work-hours / lunch-break rules.
 *
 * This is the lower-level primitive used by `findCandidateSlots` after the
 * provider has returned freebusy. `index.ts` also calls it directly with a
 * pre-intersected availability list built from attendee NL responses.
 */
export function findSlotsInWindows(
  windows: Window[],
  durationMinutes: number,
  rules: ScheduleRules,
  extraBlocked: Block[] = [],
): Candidate[] {
  const zone = rules.timezone;
  const blocked: Block[] = [...extraBlocked];

  // Add work-hour / lunch forbidden zones for every day touched by the windows
  if (windows.length > 0) {
    const firstStart = Math.min(...windows.map((w) => w.start.getTime()));
    const lastEnd = Math.max(...windows.map((w) => w.end.getTime()));
    let cursor = DateTime.fromMillis(firstStart, { zone }).startOf("day");
    const lastDay = DateTime.fromMillis(lastEnd, { zone }).endOf("day");
    while (cursor <= lastDay) {
      blocked.push(...dayForbidden(cursor, rules));
      cursor = cursor.plus({ days: 1 });
    }
  }

  const step = 15;
  const candidates: Candidate[] = [];
  for (const w of windows) {
    let t = DateTime.fromJSDate(w.start, { zone });
    const remainder = t.minute % step;
    if (remainder !== 0) {
      t = t.plus({ minutes: step - remainder }).set({ second: 0, millisecond: 0 });
    }
    const endDt = DateTime.fromJSDate(w.end, { zone });
    while (t.plus({ minutes: durationMinutes }) <= endDt) {
      const slot: Block = {
        start: t.toMillis(),
        end: t.plus({ minutes: durationMinutes }).toMillis(),
      };
      const conflict = blocked.some((b) => overlaps(slot, b));
      if (!conflict) {
        candidates.push({
          start: new Date(slot.start),
          end: new Date(slot.end),
          score: scoreSlot(t),
        });
      }
      t = t.plus({ minutes: step });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/** Parse "HH:MM-HH:MM" into [startMinutes, endMinutes] from midnight. */
function parseRange(s: string): [number, number] {
  const [a, b] = s.split("-");
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  return [ah * 60 + am, bh * 60 + bm];
}

/** Build forbidden blocks for one day from work-hours + lunch break. */
function dayForbidden(day: DateTime, rules: ScheduleRules): Block[] {
  const dayStart = day.startOf("day");
  const dayEnd = day.endOf("day");
  const [workStart, workEnd] = parseRange(rules.workHours);
  const [lunchStart, lunchEnd] = parseRange(rules.lunchBreak);

  return [
    { start: dayStart.toMillis(),                                   end: dayStart.plus({ minutes: workStart }).toMillis() },
    { start: dayStart.plus({ minutes: lunchStart }).toMillis(),     end: dayStart.plus({ minutes: lunchEnd  }).toMillis() },
    { start: dayStart.plus({ minutes: workEnd   }).toMillis(),      end: dayEnd.toMillis() },
  ].filter((b) => b.end > b.start);
}

/**
 * Walk the search window in 15-minute increments and return all slots
 * of `durationMinutes` that don't overlap any forbidden block
 * (busy + work-hours + lunch + buffers).
 */
export async function findCandidateSlots(
  provider: CalendarProvider,
  input: FindSlotInput,
): Promise<SearchResult> {
  const zone = input.rules.timezone;
  const buffer = input.rules.bufferMinutes;

  const busy = await provider.freeBusy(input.attendees, input.earliest, input.latest);

  // Pad each busy interval by buffer minutes on both sides
  const blocked: Block[] = [];
  for (const list of Object.values(busy)) {
    for (const b of list) {
      blocked.push({
        start: b.start.getTime() - buffer * 60_000,
        end:   b.end.getTime()   + buffer * 60_000,
      });
    }
  }

  // Add work-hour / lunch forbidden zones for every day in the window
  let cursor = DateTime.fromJSDate(input.earliest, { zone }).startOf("day");
  const lastDay = DateTime.fromJSDate(input.latest, { zone }).endOf("day");
  while (cursor <= lastDay) {
    blocked.push(...dayForbidden(cursor, input.rules));
    cursor = cursor.plus({ days: 1 });
  }

  // Slide through the window in 15-min steps
  const step = 15;
  const dur = input.durationMinutes;
  const candidates: Candidate[] = [];

  let t = DateTime.fromJSDate(input.earliest, { zone });
  const remainder = t.minute % step;
  if (remainder !== 0) {
    t = t.plus({ minutes: step - remainder }).set({ second: 0, millisecond: 0 });
  }

  const endDt = DateTime.fromJSDate(input.latest, { zone });
  while (t.plus({ minutes: dur }) <= endDt) {
    const slot: Block = {
      start: t.toMillis(),
      end:   t.plus({ minutes: dur }).toMillis(),
    };
    const conflict = blocked.some((b) => overlaps(slot, b));
    if (!conflict) {
      candidates.push({
        start: new Date(slot.start),
        end:   new Date(slot.end),
        score: scoreSlot(t),
      });
    }
    t = t.plus({ minutes: step });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { candidates };
}

/** Prefer afternoons, prefer earlier days, penalize edges of work day. */
function scoreSlot(start: DateTime): number {
  const h = start.hour + start.minute / 60;
  const dayOffset = start.diffNow("days").days; // smaller = sooner
  const afternoon = h >= 14 && h <= 16 ? 10 : 0;
  const edgePenalty = h < 10 || h > 17 ? -5 : 0;
  const soonBonus = -dayOffset * 2;
  return afternoon + edgePenalty + soonBonus;
}
