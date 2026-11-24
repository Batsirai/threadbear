---
name: Weekly step back
icon: 🔭
description: Once a week, a stronger model looks back over the whole week for what keeps going wrong, fixes that didn't hold, and things that have stopped earning their keep.
by: Mike
when: Sundays at 19:00
color: #2f7d6d
---

## About

A day is too short to see some things. The same problem gets patched in one
thread on Monday and another on Thursday. A fix from last week quietly stops
working. A schedule you set up a month ago still runs every morning and you
haven't opened one of its threads in weeks.

Once a week this reads back over everything you did in Threadbear: what you
typed, how your threads ended, what your schedules did. It looks for what only
shows over a week or more, and brings you a short list of the few things most
worth changing, each with what it would do about it. You pick; it does the ones
you pick.

It goes well with the Nightly retro, which handles one day's corrections. This
one is the step back. Mike has run it on a strong model since 10 Nov 2026: its
first look found a complaint he made about twice a day for two weeks that no
single thread had counted.

## Example

**Week to Sunday 22 November**

Read 640 of your messages in 112 threads, and 9 schedules' runs.

1. **"Where did that go?" came up 11 times**, always about a file an agent made
   in a folder you didn't expect. The fix last Tuesday (a line asking agents to
   pin what they make) cut it from 4 a day to 2. *Suggest:* have agents say the
   full path in their reply too.
2. **The Monday report schedule ran 4 times and you opened none of them.**
   *Suggest:* pause it, or fold it into the morning brief.
3. **Two threads built the same export button** a day apart in the shop repo.
   *Suggest:* look for an open thread on the same repo before starting a new one.

Nothing else worth your time this week.

## Setting it up

1. Tell the user what it reads: what they typed to their threads and how those
   threads ended (`list_threads` and `read_thread`), and their schedules
   (`list_schedules`). Nothing leaves their Mac.
2. Ask what it may change by itself once they've picked: their standing
   instructions, memory files and schedules, or nothing, only writing out the
   change for them to make. Default to asking first, every time.
3. Ask the day and time (default Sunday 19:00, when the week's done).
4. Write TASK.md in this folder from "Each run", with their answers. Start
   memory.md with a cutoff of 7 days ago.
5. Make the schedule with schedule_message: `new_thread` true, this folder,
   their day and time as a cron, a message saying "Read TASK.md in this folder
   and do it.", on the strongest model they have, at high effort. It's one run
   a week, so it's worth the stronger model.

## Each run

Read memory.md first: the last cutoff, what earlier runs raised, what the user
picked and what they turned down. Don't raise a turned-down idea again unless
something new makes it worth it.

1. Gather the week since the cutoff: `list_threads` (archived too) for the
   threads active in it, `read_thread` on them for what the user typed and how
   each ended (done, needed them, given up on), and `list_schedules` for what
   ran and how often its threads were opened.
2. Look for what only shows over a week:
   - the same friction fixed twice or more, with its cause still there;
   - whether earlier fixes worked: did the count fall, or did the problem move;
   - things built and taken out again within days, and what would have said so sooner;
   - what has stopped earning its keep: a schedule nobody opens, a rule nobody
     needs, a recipe that's on but never helps;
   - where the user's own attention went that an agent could have carried.
   That list is a starting point, not a form to fill in. Their attention is
   the scarce thing, so rank by how much of it a change would save.
3. Reply with at most five items, most useful first, each with what you'd do.
   Offer them as choices in your end card. A week with nothing worth raising is
   a fine result: say so in two lines and archive the thread.
4. Do the ones they pick, as TASK.md allows. Write the new cutoff, what you
   raised and what they picked or turned down in memory.md.

What the user typed is theirs: never copy it into anything shared.
