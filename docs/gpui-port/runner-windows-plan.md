# A native Windows runner: the plan

Written 17 Nov 2026, from the 9 Nov audit (`runner-windows.md`), Keith's
fork as it stood on 10 Nov (`platima/main`, 113 commits; his GitHub repo is
gone now, so the local copy is all there is), and a look at the Dell XPS.

Today a Windows PC runs the GPUI app natively and the runner in WSL
(Ubuntu 24.04, mirrored networking, a systemd unit copying the token across).
The goal is the runner running on Windows itself, installed and kept up to
date the way it is on the Mac, with WSL no longer needed.

## Where things stand

- **Main's runner has nothing for Windows yet.** Four files mention `win32`.
  Everything in the audit is still to do.
- **Keith's fork did most of the runner half**, on a base that is now 530
  runner commits behind: `platform.ts` (one place for what differs),
  `win32-hide.ts` (no console windows), `taskkill /T` kills checked against
  start times, Git Bash for patch actions and checks, a single-instance lock
  that doesn't fail open, a logon task installer (`install-windows.mjs`, which
  also fixed a real PATH-corrupting bug), `tb.cmd`, Node stand-ins for the
  `#!/bin/sh` fake CLIs in tests, a Windows CI job with a known-failing list,
  and a round of trust fixes from a six-reviewer pass (8.3 short names,
  `/c/Users` and `\\?\` spellings, `::$DATA`, SMB paths, `npm.cmd` and
  `powershell.exe` running unhashed scripts). He did not do releases or
  following main (his runner ran from the checkout and updated by installer),
  Job Objects, or the GPUI app (his UI was Tauri).
- A trial merge of his branch into main conflicts in 45 files.
- **The Dell is bare:** Windows 11 Home 26200, x64, no native Node, Git or
  Claude Code, 381 GB free.
- **The GPUI app looks for the runner at**
  `%USERPROFILE%\Library\Application Support\Threadbear` (the Mac's names,
  which is why the WSL setup copies the token there) on `127.0.0.1:8797`.

## Approaches

**A. Port main per the audit, taking Keith's pieces as they fit (my pick).**
Each slice brings in the matching part of his work as a commit with him as
author, rebased onto today's code, plus what he left out. Small landings,
each green on Mac, Linux and Windows CI, and the runner on Windows updates
itself from main like every other runner.

**B. Bring his branch in whole, then catch up.** Merge `platima/main`'s
runner and CI parts, fix 45 files of conflicts, then add releases and
follow-main. Faster to a first native thread, but one huge landing nobody
can review well, and his release model (installers, no follow-main) to undo.

**C. Keep Linux, hide WSL.** An installer that sets up and manages the WSL
runner for you. Cheapest, but it is still WSL (admin, a VM, a reboot on a
fresh PC), which is what you want gone.

## Slices (approach A)

1. **Foundations and a Windows CI job.** `platform.ts`, one spawn wrapper
   with `windowsHide`, `path.delimiter`, `expandHome` for `~\`, case-folding
   `isInside`, `.gitattributes` keeping `*.sh` LF, Node stand-ins for the
   shell fakes in tests. A `windows-latest` job in `runner.yml`: typecheck
   plus every test file not on a known-failing list that only shrinks.
   Changes nothing on the Mac.
2. **One thread natively, from source.** `claude.exe`, Git for Windows'
   `bash.exe` (never `System32\bash.exe`), `CLAUDE_CODE_USE_POWERSHELL_TOOL=0`
   so the `Bash` gates still hold, kills by `taskkill /T` checked against
   start times, the runner lock by start time, `getuid` guards, npm through
   `npm-cli.js`, `tb.cmd`, graceful stop over the IPC channel. Tried on the
   Dell on a spare port with a temp data folder and Haiku.
3. **Install and update.** `install-runner` gets a Windows path: a per-user
   Scheduled Task at logon (no admin, restarts on failure, keeps running on
   battery), started through a windowless launcher so nothing flashes up.
   Node 24 and Git are fetched per user (no UAC prompt), Claude Code by its
   own installer. Releases use a `current` text file instead of a symlink and
   a junction for `node_modules`; `deploy.mjs` becomes three-way; the runner
   follows main and hands over to a new release as on the Mac.
4. **Move the Dell XPS over.** The native runner takes the WSL one's
   runner id and key (no fifth key) and its threads, then the WSL runner is
   stopped and its units turned off. The app's `default_home` and the
   runner's data folder move to `%LOCALAPPDATA%\Threadbear` together, with
   the app still reading the old place for one release.
5. **The native helper and security parity.** A small Rust exe (it builds
   in the desktop workspace's CI already): Job Objects so nothing a thread
   started outlives it, the process table, which process owns a socket (peer
   identity), idle time and keep-awake. Then the secrets guard's Windows
   forms, Keith's trust fixes, git hooks off `/dev/null`, ACLs on
   `secrets\`. Another lab tries to break each before it's called done.
6. **Polish.** Codex on Windows, pictures, stuck-job detection, a Windows
   check host, client path display (`C:\Users\...` shown as `~`).

Slices 1 to 4 replace WSL on the Dell. 5 is where it's as safe as the Mac.

## What stays Mac-only

Screen tools (`mac-screen`), the `swiftc` secret check, BrowserBear and
ComputerCub, `taskpolicy`, frozen-CLI detection (it watches for macOS
privacy prompts), and the repo's own dev scripts (`check.sh`,
`dev-runner.sh`), which run under Git Bash at best. Patch trust stays
closed on Windows (patches run only when clicked) until slice 5 ports it.

## Things only Mike can do

- Sign in to Claude on the Dell once (slice 2). I'll start `claude auth
  login` over ssh and hand you the page on the Mac, so it shouldn't need the
  laptop itself.
- A WhatsApp to Keith saying his work is coming in under his name, if you'd
  like one.
