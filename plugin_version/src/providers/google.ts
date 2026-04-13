import { google, calendar_v3 } from "googleapis";
import {
  BusyInterval,
  CalendarProvider,
  CreateEventInput,
  CreatedEvent,
  ResolvedUser,
  UpcomingEvent,
} from "./types";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  organizerEmail: string;
}

export class GoogleCalendarProvider implements CalendarProvider {
  private cal: calendar_v3.Calendar;

  constructor(private cfg: GoogleConfig) {
    const auth = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret);
    auth.setCredentials({ refresh_token: cfg.refreshToken });
    this.cal = google.calendar({ version: "v3", auth });
  }

  async freeBusy(emails: string[], from: Date, to: Date) {
    const res = await this.cal.freebusy.query({
      requestBody: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: emails.map((id) => ({ id })),
      },
    });
    const out: Record<string, BusyInterval[]> = {};
    for (const email of emails) {
      const busy = res.data.calendars?.[email]?.busy ?? [];
      out[email] = busy.map((b) => ({
        start: new Date(b.start!),
        end: new Date(b.end!),
      }));
    }
    return out;
  }

  async createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    const res = await this.cal.events.insert({
      calendarId: this.cfg.organizerEmail,
      conferenceDataVersion: 1,
      sendUpdates: "all",
      requestBody: {
        summary: input.title,
        description: input.description,
        start: { dateTime: input.start.toISOString(), timeZone: input.timezone },
        end:   { dateTime: input.end.toISOString(),   timeZone: input.timezone },
        attendees: input.attendees.map((email) => ({ email })),
        conferenceData: {
          createRequest: {
            requestId: `oc-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      },
    });
    const ev = res.data;
    return {
      id: ev.id!,
      htmlLink: ev.htmlLink ?? undefined,
      joinUrl: ev.hangoutLink ?? undefined,
      start: new Date(ev.start!.dateTime!),
      end:   new Date(ev.end!.dateTime!),
    };
  }

  async listUpcoming(email: string, hours: number): Promise<UpcomingEvent[]> {
    const now = new Date();
    const max = new Date(now.getTime() + hours * 3600 * 1000);
    const res = await this.cal.events.list({
      calendarId: email,
      timeMin: now.toISOString(),
      timeMax: max.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    return (res.data.items ?? []).map((e) => ({
      id: e.id!,
      title: e.summary ?? "(no title)",
      start: new Date(e.start?.dateTime ?? e.start?.date ?? ""),
      end:   new Date(e.end?.dateTime   ?? e.end?.date   ?? ""),
      attendees: (e.attendees ?? []).map((a) => a.email!).filter(Boolean),
    }));
  }

  async cancelEvent(eventId: string): Promise<void> {
    await this.cal.events.delete({
      calendarId: this.cfg.organizerEmail,
      eventId,
      sendUpdates: "all",
    });
  }

  async resolveUsers(queries: string[]): Promise<ResolvedUser[]> {
    // Google Calendar identifies users by email directly; no lookup needed.
    return queries.map((q) => ({
      query: q,
      userId: q,
      via: q.includes("@") ? "email" : "unresolved",
    }));
  }
}
