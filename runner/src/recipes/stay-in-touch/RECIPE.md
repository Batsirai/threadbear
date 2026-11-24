---
name: Stay in touch
icon: 👋
description: Once a week, picks one friend you haven't spoken to in a while and drafts a short, warm message, with a photo or two. You send it.
by: Mike
when: Saturdays at 9:00
color: #d86a8c
---

## About

Friendships mostly don't end, they fade, because nobody says hi. This makes
saying hi easy. Once a week it picks one person from your list who's overdue,
looks at what you've been up to since you last spoke, and drafts two or three
short messages you could send them, ideally with a photo they'd enjoy.

It never sends anything. You pick a draft, change it if you like, and send it
from your own phone. Then tell it you did, and it remembers when you last spoke
and what about.

Mike has run it weekly since October 2026.

## Example

**Sam, last spoke 9 weeks ago** (you said you'd catch up after his move)

Photos: the new veggie patch, and the dog asleep in the wheelbarrow.

1. *Hey Sam! Finally built the veggie patch we talked about. How's the new place treating you?* (with the patch photo)
2. *How did the move go in the end? Still drowning in boxes?*
3. *Thought of you today. Coffee soon?*

His number: tap to open Messages.

## Setting it up

1. Ask who they'd like to stay in touch with, and roughly how often for each
   (every month, every three months). Write them to friends.md in this folder:
   a name, how often, when they last spoke if they know, and a line of notes.
2. Ask where it may look to see what they've been up to (their calendar, their
   photos) and where their conversations are (Messages, WhatsApp, something
   else), so a run can see when they really last spoke. Check each can be read
   on this Mac, and say plainly which can't. It reads; it never sends.
3. Ask the day and time (default Saturday 9:00).
4. Write TASK.md in this folder from "Each run", with their answers. Start
   memory.md empty.
5. Make the schedule with schedule_message: `new_thread` true, this folder,
   their day and time as a cron, a message saying "Read TASK.md in this folder
   and do it."

## Each run

1. Read friends.md and memory.md. Pick the one person most overdue, skipping
   anyone snoozed. If nobody's due, say so in one line and archive the thread.
2. Work out what to say: what the user has been up to since they last spoke
   (calendar, photos, their threads), life rather than work; and what you know
   about the friend (their notes, earlier runs, and the last few messages with
   them where TASK.md says you can read them).
3. Find two or three photos from that time they'd enjoy, if TASK.md allows:
   fun over impressive, no screenshots, no other people's children. Pin them.
4. Write two or three short openers in the user's own voice: a hi, one thing
   that's happened, a question about them. One line or two, not an essay.
5. End with an ask: Sent, Skip for now, or Pick someone else, with their
   number or a link to the chat so it's one tap.
6. When they answer: for Sent, set the date in friends.md and note what was
   said in memory.md; for Skip, snooze them a week. Then archive the thread.

Never send a message, and never put anything about these friends anywhere
shared.
