# The backend's lifecycles

Written 17 Nov 2026 (thread f2beccf5) for moving the backend's lifecycles onto
explicit state machines, one at a time. A lifecycle here is a row (or a group
of fields on one) that moves through stages over time: a status, a lease, a
`usedAt` or `revokedAt` that works as a flag. Everything below was found by
reading the code, unless it says it was tested.

## Done

| Lifecycle | States | What was wrong | Fixed in |
|---|---|---|---|
| `commands.state` (`convex/sync.ts`, "A command's lifecycle") | pending, taken, done, failed (plus `lapsedAt` on a failed one) | A take whose answer was lost made the runner's retry get `false`, so the command was dropped and stayed taken for 14 days. A finish overwrote however a command had ended. A runner that stopped mid-apply left the phone on "Sending…" for two weeks. | API 85: `takeCommand`'s `attempt`, a finish only from taken (or lapsed), a 3-hour lease (`lapseCommands`) that fails it without handing it out again |
| `threadMoves.state` (`convex/moves.ts`) | asking, ready, packing, unpacking, claimed, done, failed, cancelled | A move left `ready` (its source runner gone) was never ended, so the thread could never move again. | `expireMoves` fails a ready move once its source has been gone 10 minutes, or after 12 hours |
| `runnerRequests.state` (`convex/relay.ts`) | pending, claimed, allowed, denied, closed | A claim that went through but whose answer was lost left the request "being started" with nothing started. | API 85: `decideRequest`'s `claim`, one answer per request at a time. Still open: a lost claim followed by a runner restart stays claimed until the asking card expires (an hour); handing it back on a timer could start the thread twice, as a claimed request may already be starting elsewhere |

Each was already written as an explicit set of moves in one place (the
comment in `sync.ts`, `GOING`/`mustBeIn` in `moves.ts`, `MOVES` in
`relay.ts`), and clients read their `state` strings, so they keep them.

## Still to do, most worth it first

| # | Lifecycle | Stages | What's wrong (by reading) | Size |
|---|---|---|---|---|
| 1 | `threads.pushHeldAt` / `pushedAt` with `runners.atMac` (`devices.ts` holdPush, `sync.ts` setPresence, sendHeldPushes, sendStaleHeldPushes) | none, held, sent or dropped | **Race:** `push.notify` reads `atMac` true, `setPresence(false)` then drains (nothing held yet), then `holdPush` writes `pushHeldAt` without looking at `atMac` again. The stale-push cron only looks at runners still `atMac`, so the push waits until Mike next sits down and leaves again: a missed "needs you". | S-M |
| 2 | `schedules.claim` (`{ holder, until }`, 2-minute lease), `runRequestedAt`, `nextRunAt`, `lastRun` (`sync.ts` claimSchedule, releaseSchedule, scheduleRan) | due, claimed, ran or released | **Possible double run:** the lease isn't renewed and a schedule's `check` can run longer. **Possible late result:** `scheduleRan` takes `lastRun` and `nextRunAt` from a holder whose claim has gone. Check the runner side (`runner/src/schedules.ts`) for renewal first. | M |
| 3 | `threadClears.moving` / `done` (`sync.ts` clearThread, dropThreadRows) | clearing, done (awaiting the owner's write), gone | **Possible stuck id:** no sweep. A `dropThreadRows` run that throws leaves the row not done, and every write under that thread id is skipped (`closedId`). The rows have no timestamp, so a sweep needs one added. | M |
| 4 | `relayInstall` and `relayChecks` (`push.ts`, `devices.ts`) | none, checking, registered, cleared on 401 | **Possible race:** two `notify` actions register at once; the relay rotates the key each time and the last save wins, so a push can 401 and register again (1 of 20 a day). | S |
| 5 | `uploadTickets`, `phoneUploads`, `relayUploads` (`usedAt`, `claim`) | issued, claimed, finished or refused | Sound. Three copies of the same claim and finish could share one machine. | S |
| 6 | `storageOwners.attachedAt` | unattached, attached, deleted | None found. | S |
| 7 | `tokens.revokedAt` / `expiresAt`, `pairingCodes.usedAt` | issued, used or expired; live, revoked or expired | None found. | S |
| 8 | `runnerKeys.revokedAt` | live, revoked | None. | S |
| 9 | relay `installs` (`relay/convex/relay.ts`) | registered, active, expired, registered again | Only the rotation race in 4. | S |

Simple expiry, not worth a machine: `messages.pagedAt`, `heldPictures.at`,
`eventBodies.at`, and the `threadTombstones`, `threadGone` and `scheduleGone`
markers.

Deliberately left out: the runner-owned copies of threads (`threads`,
`threadIndex`: `status`, `archivedAt`, `starredAt`, `view`). The runner is
their source of truth; the backend only mirrors them.

## Moving them onto @convex-dev/state-machines

Mike's apps put lifecycles on his state machines library. For Threadbear
that's on hold: the library lives in a private repo, and Threadbear's repo is
public, so vendoring its package here would publish it. Until he decides,
lifecycles stay hand-written, with their moves in one place.

When it goes ahead, two things are particular to Threadbear:

- **Clients read the state strings.** The App Store iPhone app, the website
  and older runners read `state` as plain strings (`phone:command`,
  `phone:waiting`, `relay:commandState`, `moves:moves`). A machine's state is
  a `{ kind, ... }` union, so it goes on a field of its own
  (`commandState`, `moveState`, `requestState`), and the functions keep
  answering with the strings.
- **Every deployment upgrades itself, from whatever it last ran.** Each
  main Mac's runner deploys `convex/` from the commit it updates to
  (`runner/scripts/deploy-backend.mjs`), and other people's copies bring in
  Mike's releases days apart, skipping commits. A machine needs its field
  required, and Convex refuses to deploy a schema that rows already stored
  don't match. So "widen, backfill, then make it required" can't rely on
  each step being deployed in turn: a copy jumping from before the widen to
  after the narrow would fail its deploy and stop updating. The deploy
  script needs to do it: a commit that makes a field required lists the
  backfill it needs, and the script deploys the commit before it first,
  runs that backfill to the end, then deploys the rest. That works for every
  later migration too, and Ville's and Keith's servers go through it with
  nothing to do by hand.
