/**
 * Google Calendar, connected separately from the mailbox (opt-in). The assistant can see when the user is
 * busy and hold time on the user's own calendar. Held events have no attendees, so nobody is notified:
 * invitations go out as an email draft the user approves.
 */
import { GmailHttpError, MailAuthError, type FetchFn } from "./gmail.ts";

/** Read and write events on calendars the user owns. */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3/calendars/primary";

export interface BusyBlock { start: string; end: string; title: string }
export interface HeldEvent { id: string; start: string; end: string; title: string; link: string | null }

const MAX_RANGE_DAYS = 31;

function checkRange(start: Date, end: Date) {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("Give a start before the end");
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86_400_000) throw new Error(`Look at most ${MAX_RANGE_DAYS} days at a time`);
}

export class GoogleCalendar {
  private readonly accessToken: string;
  private readonly fetchFn: FetchFn;
  constructor(accessToken: string, fetchFn: FetchFn = fetch) { this.accessToken = accessToken; this.fetchFn = fetchFn; }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.fetchFn(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${this.accessToken}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (response.status === 401) throw new MailAuthError("Calendar access has expired or was revoked. Connect Google Calendar again.");
    if (!response.ok) throw new GmailHttpError(response.status);
    return (response.status === 204 ? {} : await response.json()) as T;
  }

  /** Busy times between `start` and `end` (events marked free and declined events are left out). */
  async busy(start: Date, end: Date): Promise<BusyBlock[]> {
    checkRange(start, end);
    const params = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "100" });
    const data = await this.call<{ items?: { summary?: string; transparency?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; attendees?: { self?: boolean; responseStatus?: string }[] }[] }>(`/events?${params}`);
    return (data.items ?? [])
      .filter((e) => e.transparency !== "transparent" && !e.attendees?.some((a) => a.self && a.responseStatus === "declined"))
      .map((e) => ({ start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? e.end?.date ?? "", title: (e.summary ?? "Busy").slice(0, 120) }));
  }

  /** Holds time on the user's own calendar: no attendees, so no invitations are sent. */
  async hold(input: { title: string; start: Date; end: Date; description?: string; timeZone?: string }): Promise<HeldEvent> {
    checkRange(input.start, input.end);
    if (input.end.getTime() - input.start.getTime() > 12 * 3_600_000) throw new Error("Hold at most 12 hours at once");
    const event = await this.call<{ id: string; htmlLink?: string; summary?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }>("/events?sendUpdates=none", {
      method: "POST",
      body: {
        summary: input.title.replace(/[\r\n]+/g, " ").slice(0, 200),
        description: (input.description ?? "Held by the Mail Assistant.").slice(0, 2000),
        start: { dateTime: input.start.toISOString(), ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
        end: { dateTime: input.end.toISOString(), ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
        reminders: { useDefault: true },
      },
    });
    return { id: event.id, start: event.start?.dateTime ?? input.start.toISOString(), end: event.end?.dateTime ?? input.end.toISOString(), title: event.summary ?? input.title, link: event.htmlLink ?? null };
  }
}
