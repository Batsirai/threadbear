# The backend's state machines

Drawn from the rules the backend runs (`convex/machines.ts`), as the website's Machines page draws them, by `npm run machine-docs` in runner/: don't edit it by hand. docs/lifecycles.md says which lifecycles are machines so far, and which are next.

## command

Something the phone, the website or the main Mac asked a runner to do: it waits for its runner, which takes it once, runs it and says how it went.

```mermaid
stateDiagram-v2
  direction LR
  state "pending" as pending
  note right of pending
Waiting for its runner to take it: the
runner may be asleep. The phone can
still take a message back.
  end note
  state "taken" as taken
  taken : takenAt, attempt?
  note right of taken
Its runner has it and is running it.
Asked again by the same take (its answer
was lost), it says yes; nobody else gets
it.
  end note
  state "done" as done
  done : doneAt
  note right of done
Its runner ran it and it worked.
  end note
  state "failed" as failed
  failed : doneAt
  note right of failed
It didn't happen or didn't work: its
runner said so, the phone took it back,
nobody took it in time, or its thread
moved or went.
  end note
  state "lapsed" as lapsed
  lapsed : doneAt, lapsedAt
  note right of lapsed
Its runner never said how it went within
the lease. Shown as failed; its runner's
late answer still settles it.
  end note
  [*] --> pending : QUEUE (sender) / queue
  pending --> taken : TAKE(attempt?) (runner) / take
  pending --> failed : CANCEL (phone) / cancel
  pending --> failed : THREAD_ELSEWHERE (runner) / elsewhere
  pending --> failed : EXPIRED after 14 days / expire
  pending --> failed : EXPIRE (server) / expire
  taken --> taken : TAKE(attempt?) (runner) [sameAttempt]
  taken --> done : FINISH(ok) (runner) [1. worked] / done
  taken --> failed : FINISH(ok) (runner) [else] / failed
  taken --> lapsed : LEASE_LAPSED after 3 hours / lapse
  taken --> lapsed : LAPSE (server) / lapse
  lapsed --> done : FINISH(ok) (runner) [1. worked] / done
  lapsed --> failed : FINISH(ok) (runner) [else] / failed
  done --> [*]
  failed --> [*]
```

How a row is born:

- `QUEUE (sender)` → `pending`. The phone, the website or the main Mac asks a runner to do something: a message, a new thread, a setting.

From `pending`:

- The clock sends `EXPIRED` after 14 days. Two weeks have passed and its runner never took it.
- `TAKE(attempt?) (runner)` → `taken`. Its runner takes it, once: any other take is refused.
- `CANCEL (phone)` → `failed`. The phone takes the message back before its runner has it.
- `THREAD_ELSEWHERE (runner)` → `failed`. Its thread moved to another runner or was deleted before it was taken, so this runner never runs it.
- `EXPIRED after 14 days` → `failed`. Nobody took it in two weeks.
- `EXPIRE (server)` → `failed`. The sweep finds it waiting past two weeks (rows from before timers).

From `taken`:

- The clock sends `LEASE_LAPSED` after 3 hours. Three hours have passed and its runner never said how it went: it stopped partway, or has been away too long.
- `TAKE(attempt?) (runner)` [sameAttempt] stays put. The same take asking again after its answer was lost: told yes, and nothing changes.
- `FINISH(ok) (runner)` [1. worked] → `done`. Its runner says it worked.
- `FINISH(ok) (runner)` [else] → `failed`. Its runner says it didn't work, and why.
- `LEASE_LAPSED after 3 hours` → `lapsed`. It lapses, shown as failed. It is never handed out again, as it may have run.
- `LAPSE (server)` → `lapsed`. The sweep finds it taken past its lease (rows from before timers).

From `lapsed`:

- `FINISH(ok) (runner)` [1. worked] → `done`. Its runner says it worked.
- `FINISH(ok) (runner)` [else] → `failed`. Its runner says it didn't work, and why.
