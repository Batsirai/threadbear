---
id: livePages
name: Live pages
title: Live pages: a page an agent shows in its reply runs in the thread, sealed, on the Mac and the phone
added: 2026-11-19
on: false
reminder: 7a0d9e6c
---

## What it does

An agent can show you something that moves or that you can turn around (a 3D model, an animation, a small simulation) as a live page: one self-contained HTML file it puts in its reply like a picture, `![Garden lights](/path/garden.html)`. The page goes to your phone too, the way pictures in replies do (at most 10 MB), and the thread shows it as a card with Run. Run starts its scripts there in the card, for that version of the page on that device. It stays sealed off: it can't reach the internet or read any file but its own, and it can't open anything. A page an agent only pins stays on the Mac.

## Lives in

`runner/src/share-images.ts` (`PAGE_TYPE`, `sniffPage`, `replyImagesInEvent`'s `pages`), `livePages()` and the upload in `runner/src/sync.ts`, `REPLY_TYPES` in `convex/sync.ts` and `mediaType` in `convex/share.ts`'s `phoneImage`. docs/live-pages-design/README.md has the plan and what's built.

## Taking it out

Delete the file, `PAGE_TYPE`, `sniffPage` and the `pages` argument in share-images.ts, `livePages()` in sync.ts, and `text/html` from `REPLY_TYPES` in convex/sync.ts.
