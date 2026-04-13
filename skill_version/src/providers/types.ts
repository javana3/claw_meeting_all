export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface CreateEventInput {
  title: string;
  description?: string;
  start: Date;
  end: Date;
  attendees: string[];
  timezone: string;
}

export interface CreatedEvent {
  id: string;
  htmlLink?: string;
  joinUrl?: string;
  start: Date;
  end: Date;
}

export interface UpcomingEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  attendees: string[];
}

export interface DirectoryCandidate {
  /** Canonical id (open_id for Lark). */
  userId: string;
  /** Primary display name. */
  name: string;
  en_name?: string;
  nickname?: string;
  email?: string;
}

export interface ResolvedUser {
  /** Original query string (email / name / phone / open_id). */
  query: string;
  /** Internal id usable by the calendar APIs (open_id for Lark). Empty when unresolved. */
  userId: string;
  /** Display name if the backend returned one. */
  name?: string;
  /** How the resolution happened. */
  via: "open_id" | "email" | "phone" | "name" | "unresolved";
  /**
   * When via === "unresolved" and the query looked like a name, the Lark
   * provider fills this with the full tenant directory snapshot so the
   * LLM can pick the correct user itself. The plugin does NOT do any
   * fuzzy/substring matching -- that's the LLM's job.
   */
  candidates?: DirectoryCandidate[];
}

/**
 * Abstract calendar backend. Implement this once per provider
 * (Google, Outlook, Lark, DingTalk, ...).
 */
export interface CalendarProvider {
  /** Return busy intervals for each attendee in [from, to]. */
  freeBusy(emails: string[], from: Date, to: Date): Promise<Record<string, BusyInterval[]>>;

  createEvent(input: CreateEventInput): Promise<CreatedEvent>;

  listUpcoming(email: string, hours: number): Promise<UpcomingEvent[]>;

  cancelEvent(eventId: string): Promise<void>;

  /** Resolve free-form queries (name / email / phone / open_id) into user ids. */
  resolveUsers(queries: string[]): Promise<ResolvedUser[]>;

  /**
   * Optional: send a plain-text direct message from the bot to a user.
   * Implemented by Lark (via /open-apis/im/v1/messages). Not available on
   * Google Calendar (no messaging surface). Callers must feature-detect via
   * `typeof provider.sendTextDM === "function"` before calling.
   */
  sendTextDM?(userId: string, text: string): Promise<string>;
}
