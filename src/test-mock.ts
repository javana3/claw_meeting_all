/**
 * Local mock run — exercises the scheduler without touching Google.
 *
 *   npm install
 *   npm run build
 *   node dist/test-mock.js
 */
import { DateTime } from "luxon";
import { MockCalendarProvider } from "./providers/mock";
import { findCandidateSlots, ScheduleRules } from "./scheduler";

const ZONE = "Asia/Shanghai";
const rules: ScheduleRules = {
  timezone: ZONE,
  workHours: "09:00-18:00",
  lunchBreak: "12:00-13:30",
  bufferMinutes: 15,
};

// Anchor "tomorrow" so the test is deterministic relative to today.
const tomorrow = DateTime.now().setZone(ZONE).plus({ days: 1 }).startOf("day");

function at(hour: number, minute = 0): Date {
  return tomorrow.set({ hour, minute }).toJSDate();
}

const alice = "alice@acme.com";
const bob   = "bob@acme.com";
const carol = "carol@acme.com";

// Seed: each attendee has a few busy blocks tomorrow
const provider = new MockCalendarProvider({
  [alice]: [
    { start: at(9, 0),  end: at(10, 0)  }, // standup
    { start: at(14, 0), end: at(15, 0)  }, // 1:1
  ],
  [bob]: [
    { start: at(10, 30), end: at(11, 30) }, // review
    { start: at(15, 0),  end: at(16, 30) }, // workshop
  ],
  [carol]: [
    { start: at(9, 30), end: at(10, 30) },
    { start: at(13, 30), end: at(14, 30) },
  ],
});

function fmt(d: Date): string {
  return DateTime.fromJSDate(d, { zone: ZONE }).toFormat("yyyy-MM-dd HH:mm");
}

async function main() {
  console.log("=".repeat(70));
  console.log("MOCK SCHEDULER RUN — tomorrow =", tomorrow.toISODate());
  console.log("=".repeat(70));

  // ---------- Scenario 1: 30-min slot for 3 people, anytime tomorrow ----------
  console.log("\n[1] Find 30-min slot for alice + bob + carol, all day tomorrow");
  const r1 = await findCandidateSlots(provider, {
    attendees: [alice, bob, carol],
    durationMinutes: 30,
    earliest: tomorrow.set({ hour: 9 }).toJSDate(),
    latest:   tomorrow.set({ hour: 18 }).toJSDate(),
    rules,
  });
  console.log(`  found ${r1.candidates.length} candidates, top 5:`);
  r1.candidates.slice(0, 5).forEach((c, i) =>
    console.log(`    ${i + 1}. ${fmt(c.start)} → ${fmt(c.end)}  score=${c.score.toFixed(1)}`),
  );

  // ---------- Scenario 2: book the best one ----------
  console.log("\n[2] Booking the top candidate");
  if (r1.candidates.length === 0) throw new Error("expected candidates");
  const ev = await provider.createEvent({
    title: "Q2 design sync",
    description: "Auto-booked by mock test",
    start: r1.candidates[0].start,
    end:   r1.candidates[0].end,
    attendees: [alice, bob, carol],
    timezone: ZONE,
  });
  console.log(`  booked ${ev.id}`);
  console.log(`  ${fmt(ev.start)} → ${fmt(ev.end)}`);
  console.log(`  join: ${ev.joinUrl}`);

  // ---------- Scenario 3: same query — should now skip the booked slot ----------
  console.log("\n[3] Re-running the same query — booked slot should be gone");
  const r2 = await findCandidateSlots(provider, {
    attendees: [alice, bob, carol],
    durationMinutes: 30,
    earliest: tomorrow.set({ hour: 9 }).toJSDate(),
    latest:   tomorrow.set({ hour: 18 }).toJSDate(),
    rules,
  });
  const stillThere = r2.candidates.some(
    (c) => c.start.getTime() === r1.candidates[0].start.getTime(),
  );
  console.log(`  previously-booked slot still in candidates? ${stillThere}  (expect false)`);
  console.log(`  new top candidate: ${fmt(r2.candidates[0].start)} → ${fmt(r2.candidates[0].end)}`);

  // ---------- Scenario 4: 1-hour slot, afternoon only ----------
  console.log("\n[4] Find 60-min slot afternoon only (13:00–18:00)");
  const r3 = await findCandidateSlots(provider, {
    attendees: [alice, bob, carol],
    durationMinutes: 60,
    earliest: tomorrow.set({ hour: 13 }).toJSDate(),
    latest:   tomorrow.set({ hour: 18 }).toJSDate(),
    rules,
  });
  console.log(`  found ${r3.candidates.length} candidates, top 3:`);
  r3.candidates.slice(0, 3).forEach((c, i) =>
    console.log(`    ${i + 1}. ${fmt(c.start)} → ${fmt(c.end)}  score=${c.score.toFixed(1)}`),
  );

  // ---------- Scenario 5: impossible — narrow window full of conflicts ----------
  console.log("\n[5] Impossible case: 90 min in 14:00–15:30 (everyone busy)");
  const r4 = await findCandidateSlots(provider, {
    attendees: [alice, bob, carol],
    durationMinutes: 90,
    earliest: tomorrow.set({ hour: 14 }).toJSDate(),
    latest:   tomorrow.set({ hour: 15, minute: 30 }).toJSDate(),
    rules,
  });
  console.log(`  found ${r4.candidates.length} candidates  (expect 0)`);

  // ---------- Scenario 6: list & cancel ----------
  console.log("\n[6] list_upcoming + cancel_meeting");
  const upcoming = await provider.listUpcoming(alice, 48);
  console.log(`  upcoming: ${upcoming.length}`);
  upcoming.forEach((e) =>
    console.log(`    - ${e.id}: ${e.title}  ${fmt(e.start)}`),
  );
  await provider.cancelEvent(ev.id);
  const after = await provider.listUpcoming(alice, 48);
  console.log(`  after cancel: ${after.length}  (expect 0)`);

  // ---------- Scenario 7: simulate the user's exact request ----------
  // User says: "帮我向 A@test.com 和 B@test.com 约一个会议，
  //             大概在明天下午 14:00-19:00 之间，时间大概 30 分钟吧"
  //
  // The OpenClaw LLM would translate that into the JSON below and call
  // find_and_book_meeting. Here we run the scheduler directly with a
  // separate provider (A and B both have realistic afternoon busy blocks).
  console.log("\n[7] Simulating real user request: A@test.com + B@test.com, " +
              "tomorrow 14:00–19:00, 30 min");

  const userProvider = new MockCalendarProvider({
    "A@test.com": [
      { start: at(14, 30), end: at(15, 0)  }, // quick sync
      { start: at(16, 0),  end: at(17, 0)  }, // 1:1
    ],
    "B@test.com": [
      { start: at(15, 30), end: at(16, 30) }, // review
    ],
  });

  const r7 = await findCandidateSlots(userProvider, {
    attendees: ["A@test.com", "B@test.com"],
    durationMinutes: 30,
    earliest: tomorrow.set({ hour: 14 }).toJSDate(),
    latest:   tomorrow.set({ hour: 19 }).toJSDate(),
    rules,
  });

  console.log(`  found ${r7.candidates.length} candidates, top 5:`);
  r7.candidates.slice(0, 5).forEach((c, i) =>
    console.log(`    ${i + 1}. ${fmt(c.start)} → ${fmt(c.end)}  score=${c.score.toFixed(1)}`),
  );

  if (r7.candidates.length > 0) {
    const booked = await userProvider.createEvent({
      title: "Meeting with A and B",
      start: r7.candidates[0].start,
      end:   r7.candidates[0].end,
      attendees: ["A@test.com", "B@test.com"],
      timezone: ZONE,
    });
    console.log(`\n  >>> agent reply would be:`);
    console.log(`  >>> "已为你预订会议 'Meeting with A and B'`);
    console.log(`  >>>  时间: ${fmt(booked.start)} – ${fmt(booked.end)}`);
    console.log(`  >>>  邀请已发送给 A@test.com, B@test.com`);
    console.log(`  >>>  会议链接: ${booked.joinUrl}"`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("ALL SCENARIOS DONE");
  console.log("=".repeat(70));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
