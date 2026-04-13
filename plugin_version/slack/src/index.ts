/**
 * OpenClaw plugin: meeting-scheduler-slack
 *
 * Thin entry point — all core logic lives in claw-meeting-shared.
 * This file only provides the Slack-specific provider and config.
 */
import { loadEnv, createMeetingPlugin } from "claw-meeting-shared";
import { SlackProvider } from "./providers/slack";

loadEnv();

const plugin = createMeetingPlugin({
  id: "meeting-scheduler-slack",
  name: "Meeting Scheduler (Slack)",
  description:
    "Find common free slots between Slack workspace users and book calendar events via natural language.",
  version: "0.1.0",

  createProvider: (cfg) => new SlackProvider({ botToken: cfg.SLACK_BOT_TOKEN }),

  userIdPattern: /^U[A-Z0-9]{8,}$/,
  looksLikeUserId: (s) => /^U[A-Z]/.test(s),

  platformName: "Slack",
  identifierExamples:
    "display name (e.g. 'Alice', 'Bob Smith'), email (e.g. alice@company.com), " +
    "or Slack User ID (e.g. U01ABC2DEF3 — only if explicitly provided)",
  directoryDescription: "Slack workspace directory (users.list API)",
});

export default plugin;
module.exports = plugin;
