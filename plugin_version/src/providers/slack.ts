/**
 * Slack provider for the meeting-scheduler plugin.
 *
 * ===========================================================================
 * SOURCE-OF-TRUTH CITATIONS
 * ===========================================================================
 * All Slack API calls in this file are verified against the official Slack
 * Web API documentation at https://api.slack.com/methods and the
 * @slack/web-api npm package (^7.x).
 *
 * 1. chat.postMessage — Send a DM to a user
 *    Doc: https://api.slack.com/methods/chat.postMessage
 *    SDK: WebClient.chat.postMessage({ channel, text })
 *    - `channel` accepts a User ID (U prefix) directly; Slack auto-creates
 *      or resumes the DM conversation.
 *    - Scope: chat:write
 *    - Rate: Special tier — 1 message/second/channel (burst allowed)
 *
 * 2. users.lookupByEmail — Resolve email to Slack user
 *    Doc: https://api.slack.com/methods/users.lookupByEmail
 *    SDK: WebClient.users.lookupByEmail({ email })
 *    - Error code "users_not_found" when no match.
 *    - Scope: users:read.email
 *    - Rate: Tier 3 (50+/min)
 *
 * 3. users.list — List all workspace members (paginated)
 *    Doc: https://api.slack.com/methods/users.list
 *    SDK: WebClient.users.list({ limit, cursor })
 *    - Cursor-based pagination via response_metadata.next_cursor
 *    - Scope: users:read, users:read.email (for email field)
 *    - Rate: Tier 2 (20+/min)
 *
 * 4. users.info — Get single user details
 *    Doc: https://api.slack.com/methods/users.info
 *    SDK: WebClient.users.info({ user })
 *    - Scope: users:read
 *    - Rate: Tier 4 (100+/min)
 * ===========================================================================
 */

import { WebClient } from "@slack/web-api";
import type {
  CalendarProvider,
  BusyInterval,
  CreateEventInput,
  CreatedEvent,
  UpcomingEvent,
  ResolvedUser,
  DirectoryCandidate,
} from "claw-meeting-shared";

// ============================================================================
// Configuration
// ============================================================================

export interface SlackProviderConfig {
  botToken: string; // xoxb-...
}

// ============================================================================
// Constants
// ============================================================================

/** Directory cache TTL — same as Lark provider (60 min). */
const DIRECTORY_TTL_MS = 60 * 60 * 1000;

/** Max members per users.list page (Slack recommends ≤200). */
const USERS_LIST_PAGE_SIZE = 200;

/** Max pages to fetch (safety limit to prevent infinite loops). */
const MAX_PAGES = 200;

// ============================================================================
// SlackProvider
// ============================================================================

export class SlackProvider implements CalendarProvider {
  private client: WebClient;

  /** Cached workspace directory (all non-bot, non-deleted users). */
  private directoryCache: DirectoryCandidate[] | null = null;
  private directoryCacheAt = 0;

  /**
   * In-flight directory promise — prevents N concurrent name lookups from
   * triggering N independent users.list crawls. Same pattern as Lark provider.
   */
  private directoryPromise: Promise<DirectoryCandidate[]> | null = null;

  constructor(config: SlackProviderConfig) {
    this.client = new WebClient(config.botToken, {
      // @slack/web-api has built-in retry for rate-limited (429) responses.
      // Default retryConfig retries up to 10 times with exponential backoff.
    });
    console.error(`[slack.http] WebClient initialised (token ${config.botToken.slice(0, 10)}…)`);
  }

  // --------------------------------------------------------------------------
  // sendTextDM — Send a plain-text DM to a Slack user
  // --------------------------------------------------------------------------

  async sendTextDM(userId: string, text: string): Promise<string> {
    const preview = text.length > 80 ? text.slice(0, 80) + "…" : text;
    console.error(`[slack.dm] → ${userId}: "${preview}"`);

    try {
      const res = await this.client.chat.postMessage({
        channel: userId, // Slack accepts User ID directly for DMs
        text,
      });

      if (!res.ok) {
        console.error(`[slack.dm] ✗ postMessage failed: ${res.error}`);
        throw new Error(`chat.postMessage failed: ${res.error}`);
      }

      const ts = res.ts ?? "";
      console.error(`[slack.dm] ✓ delivered ts=${ts}`);
      return ts;
    } catch (err: any) {
      console.error(`[slack.dm] ✗ exception: ${err.message ?? err}`);
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // resolveUsers — Resolve free-form queries to Slack user IDs
  // --------------------------------------------------------------------------

  async resolveUsers(queries: string[]): Promise<ResolvedUser[]> {
    const results: ResolvedUser[] = [];

    // Separate queries into categories
    const directIds: { query: string; userId: string }[] = [];
    const emails: string[] = [];
    const names: string[] = [];

    for (const q of queries) {
      const trimmed = q.trim();
      if (!trimmed) continue;

      if (/^U[A-Z0-9]{8,}$/.test(trimmed)) {
        // Slack User ID — pass through directly
        directIds.push({ query: trimmed, userId: trimmed });
        console.error(`[slack.resolve] "${trimmed}" → classified as user_id`);
      } else if (trimmed.includes("@") && trimmed.includes(".")) {
        // Looks like an email
        emails.push(trimmed);
        console.error(`[slack.resolve] "${trimmed}" → classified as email`);
      } else {
        // Treat as display name
        names.push(trimmed);
        console.error(`[slack.resolve] "${trimmed}" → classified as name`);
      }
    }

    // --- Direct user IDs: verify they exist via users.info ---
    for (const { query, userId } of directIds) {
      try {
        const info = await this.client.users.info({ user: userId });
        if (info.ok && info.user) {
          results.push({
            query,
            userId,
            name: info.user.real_name || info.user.name || undefined,
            via: "open_id",
          });
          console.error(`[slack.resolve] ✓ user_id ${userId} → ${info.user.real_name}`);
        } else {
          results.push({ query, userId: "", via: "unresolved" });
          console.error(`[slack.resolve] ✗ user_id ${userId} → not found`);
        }
      } catch (err: any) {
        results.push({ query, userId: "", via: "unresolved" });
        console.error(`[slack.resolve] ✗ user_id ${userId} → error: ${err.message}`);
      }
    }

    // --- Email lookup: one at a time (Slack has no batch email API) ---
    for (const email of emails) {
      try {
        const res = await this.client.users.lookupByEmail({ email });
        if (res.ok && res.user) {
          results.push({
            query: email,
            userId: res.user.id!,
            name: res.user.real_name || res.user.name || undefined,
            via: "email",
          });
          console.error(`[slack.resolve] ✓ email ${email} → ${res.user.id} (${res.user.real_name})`);
        } else {
          results.push({ query: email, userId: "", via: "unresolved" });
          console.error(`[slack.resolve] ✗ email ${email} → not found`);
        }
      } catch (err: any) {
        // Slack throws an error with data.error === "users_not_found" when no match
        if (err.data?.error === "users_not_found") {
          results.push({ query: email, userId: "", via: "unresolved" });
          console.error(`[slack.resolve] ✗ email ${email} → users_not_found`);
        } else {
          results.push({ query: email, userId: "", via: "unresolved" });
          console.error(`[slack.resolve] ✗ email ${email} → error: ${err.message}`);
        }
      }
    }

    // --- Name lookup: fetch full directory, return candidates for LLM ---
    if (names.length > 0) {
      const directory = await this.listAllUsers();
      for (const name of names) {
        results.push({
          query: name,
          userId: "",
          via: "unresolved",
          candidates: directory,
        });
        console.error(
          `[slack.resolve] name "${name}" → returning ${directory.length} candidates for LLM`
        );
      }
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // listAllUsers — Full workspace directory fetch with caching
  // --------------------------------------------------------------------------

  async listAllUsers(): Promise<DirectoryCandidate[]> {
    // Return cache if fresh
    if (this.directoryCache && Date.now() - this.directoryCacheAt < DIRECTORY_TTL_MS) {
      console.error(`[slack.walk] directory cache hit (${this.directoryCache.length} users)`);
      return this.directoryCache;
    }

    // Concurrent dedup: if a fetch is already in flight, await that
    if (this.directoryPromise) {
      console.error(`[slack.walk] directory fetch already in-flight, awaiting…`);
      return this.directoryPromise;
    }

    this.directoryPromise = this.fetchDirectory();
    try {
      const result = await this.directoryPromise;
      this.directoryCache = result;
      this.directoryCacheAt = Date.now();
      return result;
    } finally {
      this.directoryPromise = null;
    }
  }

  private async fetchDirectory(): Promise<DirectoryCandidate[]> {
    console.error(`[slack.walk] starting workspace directory fetch…`);
    const candidates: DirectoryCandidate[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = undefined;
    let page = 0;

    do {
      page++;
      if (page > MAX_PAGES) {
        console.error(`[slack.walk] safety limit reached (${MAX_PAGES} pages), stopping`);
        break;
      }

      const startMs = Date.now();
      const res = await this.client.users.list({
        limit: USERS_LIST_PAGE_SIZE,
        cursor: cursor || undefined,
      });
      const elapsed = Date.now() - startMs;
      console.error(
        `[slack.http] users.list page=${page} cursor=${cursor?.slice(0, 20) ?? "∅"} ` +
          `status=${res.ok ? "ok" : res.error} elapsed=${elapsed}ms`
      );

      if (!res.ok || !res.members) {
        console.error(`[slack.walk] ✗ users.list failed: ${res.error}`);
        break;
      }

      for (const m of res.members) {
        // Skip bots, deleted users, and Slackbot
        if (m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
        if (!m.id || seen.has(m.id)) continue;
        seen.add(m.id);

        const candidate: DirectoryCandidate = {
          userId: m.id,
          name: m.real_name || m.name || m.id,
          en_name: m.profile?.display_name || undefined,
          email: m.profile?.email || undefined,
        };
        candidates.push(candidate);
        console.error(
          `[slack.walk]   ${candidate.name} (${candidate.en_name ?? "-"}) ` +
            `email=${candidate.email ?? "-"} id=${candidate.userId}`
        );
      }

      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);

    console.error(`[slack.walk] ✓ directory complete: ${candidates.length} users, ${page} pages`);
    return candidates;
  }

  // --------------------------------------------------------------------------
  // Calendar methods — stubs (not yet implemented)
  // --------------------------------------------------------------------------

  async freeBusy(
    _emails: string[],
    _from: Date,
    _to: Date
  ): Promise<Record<string, BusyInterval[]>> {
    throw new Error(
      "[SlackProvider] Calendar backend not configured. " +
        "freeBusy is not available until a calendar provider (Google Calendar, Outlook, etc.) is integrated."
    );
  }

  async createEvent(_input: CreateEventInput): Promise<CreatedEvent> {
    throw new Error(
      "[SlackProvider] Calendar backend not configured. " +
        "createEvent is not available until a calendar provider is integrated."
    );
  }

  async listUpcoming(_email: string, _hours: number): Promise<UpcomingEvent[]> {
    throw new Error(
      "[SlackProvider] Calendar backend not configured. " +
        "listUpcoming is not available until a calendar provider is integrated."
    );
  }

  async cancelEvent(_eventId: string): Promise<void> {
    throw new Error(
      "[SlackProvider] Calendar backend not configured. " +
        "cancelEvent is not available until a calendar provider is integrated."
    );
  }
}
