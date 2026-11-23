---
id: quietInboxMine
name: Quiet inbox for your threads
title: Quiet inbox for your threads: your own finished threads that a model says you didn't need to see go straight to Archived
added: 2026-11-23
on: false
reminder: 994605b5
---

## What it does

Part of the quiet inbox. Threads another thread started already archive themselves when they finish with nothing for you; this does the same for your own threads, when a model is confident you didn't need to read the reply. It needs Inbox guess on too, as the guess comes from there: when one of your threads finishes with nothing for you and nothing left open, the strong model (Opus) guesses whether you needed to see it. If it says no, the thread is archived with a line in it saying why. A thread with follow-ups, anything left open, a star, one you've already looked at, or one you once brought back out of the archive is never archived this way, and nothing happens if Opus couldn't answer.

To check what it hid, the bottom of the Inbox says "Quietly archived: 6 today". Click it for the list, newest first. Open any of them as usual, or press "Should have shown me" on one: it comes back to your inbox at once, and the miss is written down so the guess can be scored. The decisions and your corrections are in `inbox-guess.jsonl` in the runner's data folder. Threads on another runner aren't part of it yet, and the phone and the website don't show the list.

## Lives in

`quietArchive` in `runner/src/runner/inbox-guess.ts` (called from `guessInbox`); `quietlyArchived` on the thread record (`store.ts`, cleared in `parkRecord` in `place.ts`) and on its summary (`runner.ts` summary, `protocol.ts`); the `shouldHaveShown` verdict on an unarchive (`runner.ts` update, `rpc.ts`); in the desktop app `quiet_today` in `desktop/core/src/sidebar.rs` and `desktop/gpui/src/quiet_inbox.rs` and `MenuAction::ShouldHaveShown` in `desktop/gpui/src/sidebar.rs`

## Taking it out

Delete `quietArchive` and its call in `guessInbox`, `quietlyArchived` on the record and the summary and its clearing in `parkRecord`, the `shouldHaveShown` verdict and its `wrongHide` line, and in the desktop app the quiet line, its list and `MenuAction::ShouldHaveShown`. Threads it archived stay archived, as by Threadbear.
