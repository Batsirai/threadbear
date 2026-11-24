---
name: Daily standup
icon: 🗣️
description: Each work morning, a draft of your standup from what you actually did yesterday, ready for you to check and post.
by: Mike
when: Weekdays at 8:00
color: #c9783a
---

## About

A standup is meant to take two minutes, but writing one means remembering what
you did yesterday, and most people undersell it. The threads you ran know: what
landed, what you fixed, what you reviewed, what's stuck.

Each work morning this reads yesterday's threads and your calendar, and drafts
your standup in the format your team uses: done, today, blockers. You check it,
change what you like and post it yourself. It never posts for you.

Mike has had a version of this since October 2026. It also remembers what you
change in its drafts, so they read more like you over time.

## Example

**Yesterday**
- Shipped the CSV export for invoices (PR merged, live by 4 pm)
- Fixed the sign-in loop on Safari that support flagged
- Reviewed Ana's billing PR, two small notes

**Today**
- Start on the team invites page
- 11:00 planning call

**Blockers**
- None

*Draft only: nothing posted. Tap to copy.*

## Setting it up

1. Ask where they post their standup (a Slack or Teams channel, an email, a
   doc), the format their team uses, and the time they'd like the draft. Ask
   for a past standup or two to copy the style from.
2. Check what you can read: their threads (always), their calendar if a
   calendar connector is signed in, and the chat tool if one is. If the chat
   tool can save a draft (Slack's can), say so and ask if they'd like that.
   It must never post or send.
3. Write TASK.md in this folder from "Each run", with their answers and the
   example standups. Start learnings.md empty.
4. Make the schedule with schedule_message: `new_thread` true, this folder,
   weekdays at their time as a cron, a message saying "Read TASK.md in this
   folder and do it."

## Each run

1. Read learnings.md: how the user changed earlier drafts. It wins over
   anything else here.
2. If they've already posted today's standup (when you can check), say so in
   one line and archive the thread.
3. Gather the last working day: `list_threads` for threads active since then,
   with what each did and how it ended (`read_thread` where the summary isn't
   enough); merged pull requests and commits in their repos if you can see
   them; yesterday's and today's calendar.
4. Draft the standup in their format, in their words: specific, short, what
   they did rather than what agents did. Don't undersell real work, and leave
   out noise (archived chores, failed tries that went nowhere).
5. Show the draft in your reply, save it as a draft in their chat tool if
   TASK.md says so, and end with needs "you". Never post or send it.
6. If they change the draft and tell you, or you can see what they posted,
   note what they changed and why in learnings.md, then archive the thread.
