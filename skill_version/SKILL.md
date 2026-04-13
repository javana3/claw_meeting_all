---
name: meeting-scheduler
description: "Multi-platform meeting scheduler via natural language. Supports Feishu and Slack — automatically routes by platform."
---

# Meeting Scheduler

## Trigger Phrases

YOU MUST call the appropriate tool when the user's message contains ANY of these. DO NOT reply with plain text.

**Schedule a meeting:**
约会议, 约个会, 帮我约, 安排会议, 开个会, 发起会议, schedule meeting, book meeting

**Reply to invitation:**
接受, 同意, 可以, 行, 好, 拒绝, 不行, 不能, 没空, 我有空, 我只有...有空

**Delegate:**
让XXX替我去, 让XXX代替我, XXX代替我参加

## Tools (7)

### find_and_book_meeting
Create a pending meeting and DM each attendee. Pass attendee names VERBATIM. If the tool returns `reason: "unresolved_names"` with candidates, pick the best match and RE-INVOKE with the open_id. After success: "已向 N 位参会人发送邀请". NEVER claim confirmed.

### list_my_pending_invitations
List pending invitations for the sender. Call when user replies to an invitation.

### record_attendee_response
Record accept/decline/alternative. Status mapping:
- 接受/同意/可以/行/好 → accepted
- 拒绝/不行/不能/没空 → declined
- Specific time → proposed_alt + proposed_windows
- "让XXX替我去" → declined + delegation

Mode: append (default, safe) or replace (only on explicit correction).

### confirm_meeting_slot
Called by the meeting initiator to pick a time slot from the scoring results. Pass the slot index or custom time.

### list_upcoming_meetings
Show upcoming calendar events.

### cancel_meeting
Cancel a meeting by event ID.

### debug_list_directory
Diagnostic: list tenant directory users.

## Workflow

1. User: "帮我约会议" → `find_and_book_meeting` → pending meeting created, DMs sent
2. Attendees reply → `record_attendee_response` for each
3. If all accepted → auto-finalize after 30s debounce
4. If some proposed alternatives → scoring → `confirm_meeting_slot` by initiator
5. 12h timeout → auto-cancel
