/**
 * OpenClaw plugin: meeting-scheduler (Feishu/Lark)
 *
 * Thin entry point — all core logic lives in claw-meeting-shared.
 * This file only provides the Lark-specific provider and config.
 */
import { loadEnv, createMeetingPlugin } from "claw-meeting-shared";
import { LarkCalendarProvider } from "./providers/lark";

loadEnv();

const plugin = createMeetingPlugin({
  id: "meeting-scheduler",
  name: "Meeting Scheduler",
  description:
    "Find common free slots between Feishu users and book calendar events via natural language.",
  version: "0.2.0",

  createProvider: (cfg) =>
    new LarkCalendarProvider({
      appId: cfg.LARK_APP_ID,
      appSecret: cfg.LARK_APP_SECRET,
      calendarId: cfg.LARK_CALENDAR_ID,
    }),

  userIdPattern: /^ou_[a-zA-Z0-9]{20,50}$/,
  looksLikeUserId: (s) => s.startsWith("ou_"),

  platformName: "Feishu",
  identifierExamples:
    "display name in Chinese or English (e.g. '安农', 'Alice'), " +
    "email address, phone number, or Feishu open_id (only if explicitly provided)",
  directoryDescription:
    "Feishu tenant directory (/contact/v3/users/find_by_department)",
});

export default plugin;
module.exports = plugin;
