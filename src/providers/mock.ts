import {
  BusyInterval,
  CalendarProvider,
  CreateEventInput,
  CreatedEvent,
  ResolvedUser,
  UpcomingEvent,
} from "./types";

/**
 * In-memory CalendarProvider for local testing.
 * Seed it with hardcoded busy intervals per attendee, then run the scheduler.
 */
export class MockCalendarProvider implements CalendarProvider {
  private events: (CreatedEvent & { title: string; attendees: string[] })[] = [];
  private nextId = 1;

  constructor(private busyByEmail: Record<string, BusyInterval[]>) {}

  async freeBusy(emails: string[], from: Date, to: Date) {
    const out: Record<string, BusyInterval[]> = {};
    for (const e of emails) {
      const list = this.busyByEmail[e] ?? [];
      out[e] = list.filter((b) => b.end > from && b.start < to);
    }
    return out;
  }

  async createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    const id = `mock-${this.nextId++}`;
    const ev = {
      id,
      htmlLink: `https://mock.local/event/${id}`,
      joinUrl:  `https://meet.mock.local/${id}`,
      start: input.start,
      end:   input.end,
      title: input.title,
      attendees: input.attendees,
    };
    this.events.push(ev);

    // Also add this event as a busy block for every attendee so subsequent
    // scheduling calls in the same test run see the conflict.
    for (const a of input.attendees) {
      (this.busyByEmail[a] ??= []).push({ start: input.start, end: input.end });
    }
    return ev;
  }

  async listUpcoming(_email: string, hours: number): Promise<UpcomingEvent[]> {
    const now = new Date();
    const max = new Date(now.getTime() + hours * 3600 * 1000);
    return this.events
      .filter((e) => e.start >= now && e.start <= max)
      .map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        attendees: e.attendees,
      }));
  }

  async cancelEvent(eventId: string): Promise<void> {
    this.events = this.events.filter((e) => e.id !== eventId);
  }

  async resolveUsers(queries: string[]): Promise<ResolvedUser[]> {
    // Mock: pass-through, assume every input is already a usable id
    return queries.map((q) => ({ query: q, userId: q, via: "open_id" }));
  }
}
