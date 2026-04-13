/**
 * OpenClaw plugin: meeting-scheduler (unified multi-platform)
 *
 * Single plugin that routes to the correct provider based on
 * ctx.messageChannel. No tool name conflicts — just one plugin
 * handles Feishu, Slack, Telegram, Discord, etc.
 *
 * To add a new platform:
 *   1. Create a provider file (e.g. providers/telegram.ts)
 *   2. Add a platform entry in the `platforms` map below
 *   3. Add the platform's config keys to openclaw.plugin.json
 *   4. Done
 */
import { loadEnv, createMeetingPlugin } from "claw-meeting-shared";
import { LarkCalendarProvider } from "./providers/lark";
import { SlackProvider } from "./providers/slack";

loadEnv();

const plugin = createMeetingPlugin({
  id: "meeting-scheduler",
  name: "Meeting Scheduler",
  description:
    "Find common free slots and book calendar events via natural language. " +
    "Supports Feishu and Slack — automatically routes by platform.",
  version: "0.3.0",

  platforms: {
    feishu: {
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
        "display name (Chinese/English), email, phone, or Feishu open_id",
      directoryDescription:
        "Feishu tenant directory (/contact/v3/users/find_by_department)",
    },

    slack: {
      createProvider: (cfg) =>
        new SlackProvider({ botToken: cfg.SLACK_BOT_TOKEN }),
      userIdPattern: /^U[A-Z0-9]{8,}$/,
      looksLikeUserId: (s) => /^U[A-Z]/.test(s),
      platformName: "Slack",
      identifierExamples:
        "display name, email, or Slack User ID (U...)",
      directoryDescription: "Slack workspace directory (users.list API)",
    },

    // ---- Future platforms ----
    // telegram: {
    //   createProvider: (cfg) => new TelegramProvider({ botToken: cfg.TELEGRAM_BOT_TOKEN }),
    //   userIdPattern: /^\d{5,}$/,
    //   looksLikeUserId: (s) => /^\d{5,}$/.test(s),
    //   platformName: "Telegram",
    //   identifierExamples: "username (@xxx) or Telegram user ID",
    //   directoryDescription: "Telegram group member list",
    // },
  },
});

export default plugin;
module.exports = plugin;
