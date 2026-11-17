# Virtual runners: a machine per thread, on demand

Mike, 16 Nov 2026 (thread 1cbaefb7): "you would just pick another option
from this list of where it runs. And it would be instead of it being an
actual runner on a machine that's actually live, it would be a service ...
it's just going to spin up a runner as necessary. And you can spin up as
many of these threads as you want." It must not be tied to one provider:
"It could run on anything ... whatever is the cheapest", as long as the
provider has "a minimum set of functionality that we would require".

This replaces the sandboxed-threads experiment (a container around Claude
Code on a shared runner, taken out on 16 Nov) and is the "cloud sandboxes"
half of step 6 (docs/plan.md). Coordinators are a separate experiment and
out of scope here.

Status: a plan, not built. A first draft went to a review panel (Fable,
Opus and Grok, 16 Nov), each reading the code; their changes are folded
in, and "What the review changed" at the end says what moved and why.

## What it's like when it's done

- The Runs-on menu in the new-thread box lists, after the machines, one
  entry per **virtual runner**, for example "Cloud (Fly)". It has its own
  icon and no online dot: it's always there.
- Starting a thread on it feels like starting one on bruce, only slower
  the first time. The row shows "Starting a machine" with a spinner while
  the box boots and clones the repo, the message waits in the queue, then
  the turn runs.
- The first time a thread runs on it with a Claude login that has no
  cloud token yet, the thread shows one card: "Make one for <login>" or
  "Paste a token". Making one runs `claude setup-token` on the Mac, which
  opens claude.ai to approve and gets the code back on a localhost
  callback, so there's nothing to copy. The message waits and goes once
  the token is set. The same card comes back when a token is revoked or
  expires. (Mike picked this on 17 Nov over a switch per login in
  Settings or Capy-style setup cards; Settings still lists each cloud
  token with its expiry and a link to revoke it.)
  If that login already uses a year-long token on the Mac (thread
  d0cf502c: each login may opt in, kept in its own `settings.json`), the
  card offers to use it, but a separate cloud token is the default: a box
  can leak its token, and revoking a shared one would sign the Mac out
  too. `claude auth status` reports any token as signed in, so a dead
  cloud token only shows when a turn is refused with a 401; that is what
  brings the card back.
- Ten threads on it are ten boxes. They show under the one entry, never
  as ten machines in the menu or in Settings.
- A thread that's been idle a few minutes **sleeps**: its work is saved
  out of the box, then the box is paused or deleted. The row says
  "Asleep" in the same quiet way a hibernating thread does. Sending a
  message wakes it ("Waking" with a spinner) and the turn runs when it's
  up, on the same box if the provider kept it, else on a new one restored
  from the save.
- If a box dies, the thread comes back on a new box from its last save,
  with a line in the transcript saying so and what (if anything) was lost.
- Archiving the thread deletes its box and, after `deleteAfterDays`, its
  save.
- **Move to** works both ways between a Mac and a virtual runner, with the
  same transcript, branch and uncommitted changes as any other move.
- Settings › Runners has a section per virtual runner: the provider, the
  size of box, how many boxes are running and asleep, and what they've
  cost this month.

## Decisions

1. **A box runs a whole, ordinary runner** (all three reviewers agreed).
   Not just the CLI with the runner staying on an always-on machine: the
   runner does git, worktrees, patches, transcripts and file listing in the
   thread's folder, and everything between machines (commands, mirror,
   moves, sidebar) is keyed on a `runnerId`. The runner gains a **box
   mode**: no self-update (a new release is a new image), no keep-awake,
   no systemd, no `followOrigin`, one thread, and its login's email given
   to it rather than read from `.claude.json` (a token login doesn't write
   `oauthAccount`, `runner/src/accounts.ts`). Box mode is a convenience,
   not a boundary: the agent has a shell, so every limit that matters is
   enforced in the backend.
2. **The service is in Convex.** A virtual runner is a row in a new
   `runnerServices` table (name, provider, box size, limits, image). Each
   thread on it has a `boxes` row (`serviceId, threadId, runnerId,
   provider, providerBoxId?, state, bootToken, lastHeartbeatAt,
   awakeSince, awakeSecondsToday, save?`). Convex actions call the
   provider's API; a cron sleeps idle boxes, reaps lost ones and cleans
   up. Once a thread has started, nothing needs a Mac to be on: the phone
   can start and wake threads on a virtual runner too.
3. **One `runnerId` per thread, for life; a new credential per box.** The
   thread's box runner has a `runnerId` made when the thread starts, and
   every box that ever runs that thread uses it. A new box gets a fresh
   credential in the same mutation that revokes the last one, so a wake
   onto a new box is not a move (no `rehomeRows`, no dead `runners` rows),
   and two boxes can never both act as that runner.
4. **Box credentials are their own class**, not runner keys. Runner keys
   are capped at `MAX_RUNNER_KEYS = 4` (`convex/sync.ts`), budgeted
   for whole machines, and bruce, the Hetzner box, the Pixel and the Dell
   hold all four;
   a new runner key also drops shared logins (`sync.ts:3520`). A **box
   key** is scoped in `convex/runnerAccess.ts` to one `runnerId` *and*
   one `threadId`, with caps sized for one thread, outside that limit:
   no new threads (`create_thread` from a box asks Mike with a card, as
   from any runner key), no schedules, no Pocket, no login sharing, no
   moves except its own thread's. The service sets the box's logins
   itself.
5. **Secrets come in by exchange, not in the environment.** The provider
   starts the box with one `bootToken`: single use, valid 10 minutes,
   stored hashed on the `boxes` row. The box's runner trades it over HTTPS
   for its box key; the boot token then dies. The environment, which every
   child process and the provider's API can read, holds nothing reusable.
6. **Starting and waking go through the queue, which knows about boxes.**
   - `boxes:startThread` (owner, from the Mac's runner or the phone)
     writes the `runners` row (marked `box: { serviceId }`, hidden from
     the Runs-on menu and Settings' machine list) and the `boxes` row,
     then queues the `create` command and schedules the boot.
     `queueCommand` needs that row to exist (`convex/relay.ts:301`).
   - The `create` carries what a box can't find on its own disk: the
     repo's `origin`, the subfolder and the base branch, read on the Mac
     the way `moveInfo` does (`withoutCredentials`).
   - A runner whose `boxes` row is `starting`, `asleep` or `waking` counts
     as reachable everywhere one is checked: `mustBeOnline`
     (`runner/src/relay.ts:1159`), the phone's `ONLINE_MS`
     (`convex/phone.ts`), `startMove` (`convex/moves.ts:162`).
   - Both command insert sites (`convex/relay.ts:311`, `convex/phone.ts`)
     schedule a wake when the target box is asleep. The wake is
     idempotent: it moves `asleep → waking` once, so two quick sends make
     one wake.
   - The Mac's waits (`TAKE_MS`, 20 s; 30 s for a remote create) become
     the service's measured start or wake time for a box, and the row
     shows "Starting a machine" / "Waking" rather than an error.
7. **Every sleep saves the thread out of the box first; pause is only a
   cache.** A provider can lose a paused box (Fly drops a suspend snapshot
   on host maintenance and cold-boots; a stopped Fly Machine's root disk
   is reset from the image, only Volumes persist), so the thread must not
   live only there. Before the cron sleeps a box it sends it a `save`
   command. The box:
   - commits its uncommitted work to `refs/threadbear/save` and pushes the
     thread's branch and that ref to `origin` (`cloud/<thread>`, see 10);
   - uploads the thread folder and the session transcript, gzipped and
     sealed to a **per-thread key** (made with the thread, kept on its
     `boxes` row, handed only to boxes for that thread), to Convex file
     storage, replacing the last save.
   Then the backend pauses the box if the provider can, else deletes it.
   Waking: resume the paused box if it's still there; otherwise a new box
   restores the last save (the same session id resumes, as after a move).
   The move code's packing (`runner/src/move-pack.ts`, `move-git.ts`) is
   reused for the bundle; the move protocol itself isn't, since it needs
   an online target and deletes its chunks when it ends.
8. **The minimum a provider must do**: start a Linux box from an OCI
   image with a size, a name and tags; delete a box; list boxes by tag
   (to find orphans); and let a process in the box hold an outbound
   HTTPS/WebSocket connection to Convex for hours; all from a Convex
   action over HTTPS. That's enough, because saves make every provider
   able to sleep (delete, then restore). Optional, declared as `caps`:
   pause with memory (fast wake), an egress allowlist, snapshots of a
   prepared disk (per-repo images later).
9. **The adapter interface** (`convex/boxProviders/<name>.ts`):

   ```ts
   type BoxCaps = { pause: boolean; egressAllowlist?: boolean; snapshots?: boolean };
   interface BoxProvider {
     caps: BoxCaps;
     // idempotencyKey is the boxes row's: Convex may retry an action, and a
     // retry must find the first box, not make a second.
     create(spec: { image: string; cpus: number; memoryMb: number;
       diskGb: number; env: Record<string, string>; name: string;
       tags: Record<string, string>; idempotencyKey: string })
       : Promise<{ providerBoxId: string }>;
     list(tags: Record<string, string>): Promise<{ providerBoxId: string;
       state: "running" | "paused" | "stopped" }[]>;
     pause?(id: string): Promise<void>;
     resume?(id: string): Promise<void>;
     destroy(id: string): Promise<void>;
   }
   ```

   The provider's API key is a Convex environment variable. Adding a
   provider is one file and a test against a fake HTTP server. Mike's own
   machines as a provider (Docker or gVisor on the Hetzner box) can come
   later through the same interface: a small host program that keeps one
   connection to Convex and takes jobs, as Amp's self-hosted orbs do.
10. **The Claude login is a setup token kept in Convex, as Capy does
    it.** Mike makes one with `claude setup-token` on his Mac and pastes
    it into Threadbear once per Claude account; it's stored in Convex
    sealed with a key held in a Convex environment variable, so a data
    export or backup doesn't carry it in the clear. A box gets it only
    through the boot exchange (5), keeps it in the runner's memory and
    passes it to Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`. It's never in
    the provider's machine config or on the box's disk. Codex the same
    way with its own token.

    This does mean the box holds a token that can use the whole
    subscription for up to a year, and the agent in it can read its own
    environment. Things that would avoid that, and why not:
    - **A short-lived token minted from the long one**: Claude Code has
      no way to do it (`claude setup-token` takes no options, 2.1.326).
    - **Convex holds a normal login's refresh token and hands boxes only
      the access token**, which lasts hours: logins now end after 28
      days, so Mike would sign in again every month, and it would mean
      calling Claude Code's private sign-in endpoint from Convex.
    - **A proxy in front of Anthropic that swaps a stand-in credential
      for the real one**: through Convex HTTP actions it would put every
      model request (hundreds of KB each) through Convex's usage and add
      a hop to every turn (Mike, 17 Nov). On a machine of Mike's or a
      Cloudflare Worker, it's another thing every Threadbear owner has to
      run, when Convex is "the only reliable constant" they all have.

    What limits the damage instead: Settings says which token a box uses
    and links to claude.ai to revoke it, and pasting a new one swaps it
    for every box at its next wake. A Claude account kept only for boxes
    means a revoke doesn't touch the Mac's threads. Where the provider
    has an egress allowlist (`caps.egressAllowlist`), it's on by default.
11. **GitHub tokens for one repo, decided when the box is made.** The repo
    is fixed on the `boxes` row by the owner side at start, never taken
    from what the box later writes. A git credential helper in the box asks
    for a token with its box key; a Convex action mints a GitHub App
    installation token limited to that repo and returns it, and it's never
    written to disk. The `cloud/**` push limit is a ruleset per repo
    (personal accounts have no account-wide rulesets), so only repos with
    that ruleset can be used from a box. At first that's threadbear.
12. **Limits, money and lost boxes.** Each virtual runner has `maxBoxes`
    (awake at once, default 5), `maxAwakeHours` per box per day (default
    8; past it the box is saved and slept, even with a dev server running)
    and `deleteAfterDays` for archived threads' saves. Starting past a
    limit fails at once and says what's in the way. The cron also:
    - reaps any provider box whose tag has no `boxes` row, or a row that
      isn't awake (found with `list`);
    - treats a box that's awake but hasn't heartbeated for 5 minutes as
      lost: destroys it, puts any command it had `taken` back to `pending`
      once (`convex/sync.ts:2749`; today a taken command waits 14 days),
      and restores the thread from its last save on a new box, with a
      transcript line saying so;
    - records awake seconds, which Settings shows times the provider's
      rate.
13. **What a box can't do**: anything Mac-only (simulators, Xcode,
    BrowserBear, ComputerCub, Mike's signed-in apps), the threadbear tools
    that act on a Mac, reaching his tailnet, and schedules (a sleeping box
    can't fire one; a schedule for a box thread stays on the Mac and sends
    to it, which wakes it).
14. **An experiment**, `virtual-runners`, on for Mike only, until it has
    run a week of his real threads.

## Order

1. **Spike, outside the app** (`runner/box/spike/`), on **Fly Machines and
   Daytona** (Mike has accounts with both, so nothing to sign up for; E2B
   can be a third later). The image, both adapters, a throwaway Convex
   deployment. It should prove:
   - **A paused box comes back as the same runner.** Pause for 10 minutes
     with the runner's Convex connection open, then resume: it reconnects
     and heartbeats, a command queued while it was paused stays `pending`
     and is taken exactly once. A repeated create with the same
     idempotency key doesn't make a second box. If neither provider's
     pause keeps the process reliably, stop and rethink.
   - **Losing a box loses nothing.** Destroy a paused box under a thread
     with uncommitted work: a new box restores the save, resumes the same
     Claude session with the work intact, and the old credential is
     refused.
   - **Claude Code runs on the setup token from Convex**: one real turn on
     the cheapest model, with the token reaching the box only through the
     boot exchange, and absent from the provider's machine config.
   - The numbers: cold start to first reply including clone and worktree
     setup on threadbear itself, warm wake to first reply, and the cost of
     an hour awake, paused and saved.
2. **Box mode, box keys and `boxes:startThread`**: one thread started from
   the Mac app on one provider, runs a turn, saves, sleeps, wakes on a
   message, archived and deleted.
3. **The second provider in the app**, to prove the interface isn't shaped
   like the first.
4. **The GPUI app**: the Runs-on entry, Starting/Asleep/Waking on rows,
   the Settings section. Then the phone.
5. **Move to** and from a virtual runner, GitHub tokens from Convex,
   limits and costs in Settings.

Everything here goes through the cross-lab review in AGENTS.md before
it's called done.

## Questions for Mike

- **The login** (answered 17 Nov): a setup token pasted once and kept in
  Convex, as Capy does it, not a proxy. See 10.

## What the review changed

The first draft (same day) was reviewed by Fable, Opus and Grok, each
reading the code. All three kept "a whole runner per box" and "the
service in Convex". What changed:

- **Runner keys can't be used for boxes** (all three): there are at most
  three, and a new one drops shared logins. Hence box keys (4).
- **A sleeping box would be refused as offline** before any wake could be
  scheduled, on the Mac and the phone alike, and a remote create errors
  after 30 s (all three). Hence 6.
- **Parking through the move protocol doesn't work** (all three): a move
  needs an online target, a running source to pack, and deletes its chunks
  at the end. And a provider can lose a paused box, so a thread that lives
  only in a paused box can be lost (Opus). Hence saving on every sleep
  (7), which also makes every provider able to sleep.
- **A new `runnerId` per box** would make every wake a move (Opus).
  Hence one per thread (3).
- **Secrets in the environment and a shared sealing key** were the
  biggest holes (all three): the setup token in the box is a whole
  subscription handed to an agent that runs untrusted code. Hence the
  boot-token exchange (5) and per-thread keys (7). The login proxy the
  panel suggested was later dropped for a token kept in Convex (10).
- **GitHub tokens**: the box mustn't choose the repo, and the `cloud/**`
  ruleset only exists on threadbear (Opus). Hence 11.
- **Lost commands, duplicate boxes and runaway boxes** (Grok, Fable):
  idempotent creates, requeueing a dead box's taken command, a heartbeat
  lease and an awake cap that sleeps. Hence 9 and 12.
- **The spike** now tests what the providers don't advertise (a pause
  with a live connection, losing a box, no token in the box) rather than
  their brochure.
