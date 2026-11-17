import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from './clock.ts';
import type { Logger } from './log.ts';
import type { Runner } from './runner.ts';

// Telling a thread when the Mac app has restarted onto a new build
// (docs/protocol.md, "App restarts"). An agent that changed the app asks
// Mike to Restart to Update and ends its turn; the app says `hello` with
// its build when it comes back, and each thread waiting for that gets a
// note and a message, so it can check its change in the running app.
//
// Two apps say so: the Swift Mac app (`mac`, its tree app/'s and dock/'s) and
// the GPUI app (`desktop`, desktop/'s), each followed on its own, so one of
// them reconnecting on the build it had doesn't count as the other restarting.

export type AppBuild = { commit: string; short: string; tree: string };
export type AppKind = 'mac' | 'desktop';

// `due`: the app has come back on this build, but the thread was on a
// draining runner then; it hears once it comes across (adopted).
// `fromTree`/`fromShort` are the Swift app's, from before there were two.
type Watch = {
  threadId: string;
  text?: string;
  requestedAt: string;
  fromTree?: string;
  fromShort?: string;
  fromDesktopTree?: string;
  fromDesktopShort?: string;
  due?: AppBuild;
  dueApp?: AppKind;
  // The commit the app has to contain, in the thread's repo: main's HEAD
  // when it asked, or the commit it named. An app swapping in a build it
  // staged before the thread landed is a different tree but hasn't got the
  // change (2f98f449, 17 Nov), so that keeps it waiting.
  // `trees`: that commit's tree of each app's folders, as its hello's
  // `tree` says it: a build of a later commit with the same app folders
  // (main moved on with only runner changes before the thread asked) has
  // the change too, and may be the only build that comes (Codex, 18 Nov).
  want?: { commit: string; short: string; repo: string; trees?: Partial<Record<AppKind, string>> };
};
type SavedState = { build?: AppBuild; desktopBuild?: AppBuild; watching: Watch[] };

// After a day the request has likely been forgotten: only the note.
const MAX_AGE_MS = 24 * 60 * 60_000;

export function appRestartsPath(home: string): string {
  return path.join(home, 'app-restart.json');
}

// end_turn asks that tell Mike to restart the app onto an update count as
// asking to hear about it, so the agent needn't remember the tool.
export function asksForAppRestart(asks: { action?: unknown; why?: unknown; where?: unknown }[] | undefined): boolean {
  return (asks ?? []).some((a) => /restart to update/i.test(`${a.action ?? ''} ${a.why ?? ''} ${a.where ?? ''}`));
}

// The two questions asked of git, swappable in tests. `resolve` gives a
// full commit id or undefined; `contains` says whether `commit` has
// `ancestor` in its history, or undefined when git can't tell (a commit it
// doesn't know, no repo), which counts as the old rule: any new build, or
// 'busy' when git didn't answer in time, which keeps waiting: a slow disk
// shouldn't bring back the false news this is here to stop. `tree` gives
// the trees of `dirs` at `commit`, joined with + as the apps' builds do
// (app/build-app.sh, desktop/scripts/make-bundle.sh).
export type RestartGit = {
  resolve(repo: string, rev: string): string | undefined;
  contains(repo: string, ancestor: string, commit: string): boolean | 'busy' | undefined;
  tree?(repo: string, commit: string, dirs: string[]): string | undefined;
};

// The folders each app's `tree` is made from.
const APP_DIRS: Record<AppKind, string[]> = { mac: ['app', 'dock'], desktop: ['desktop'] };

export const realGit: RestartGit = {
  resolve(repo, rev) {
    try {
      return execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
    } catch {
      return undefined;
    }
  },
  contains(repo, ancestor, commit) {
    try {
      execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, commit], { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch (e) {
      const err = e as { status?: number | null; signal?: string | null; code?: string };
      if (err.status === 1) return false;
      return err.signal || err.code === 'ETIMEDOUT' ? 'busy' : undefined;
    }
  },
  tree(repo, commit, dirs) {
    try {
      // Not --verify: it takes one revision, and the Swift app's is two.
      const out = execFileSync('git', ['-C', repo, 'rev-parse', ...dirs.map((d) => `${commit}:${d}`)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = out.split('\n').filter(Boolean);
      return lines.length === dirs.length ? lines.join('+') : undefined;
    } catch {
      return undefined;
    }
  },
};

// `away`: whether a draining runner still has the thread (handover.ts's
// Peers), so it isn't here yet but will be.
type Deps = { runner: Pick<Runner, 'get' | 'note' | 'send' | 'has'>; home: string; clock: Clock; log: Logger; away?: (threadId: string) => boolean; git?: RestartGit };

const appName = (app: AppKind) => (app === 'desktop' ? 'Threadbear GPUI app' : 'Threadbear app');

export class AppRestarts {
  private deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  // Sends a message to the thread when either app next comes back on a build
  // other than the one it's running now. Asking again replaces the request.
  // `running` names each app's build, the GPUI app's first: with both
  // connected, `build` alone was the frozen Swift app's (13 Nov).
  // `commit`: what the new build must contain, by default main's HEAD in
  // the thread's folder (a thread's worktree shares its refs).
  watch(threadId: string, text?: string, commit?: string): { build?: AppBuild; running?: string; waitingFor?: string } {
    const want = this.wanted(threadId, commit);
    const state = this.read();
    state.watching = state.watching.filter((w) => w.threadId !== threadId);
    state.watching.push({
      threadId,
      ...(text?.trim() ? { text: text.trim() } : {}),
      requestedAt: new Date(this.deps.clock.now()).toISOString(),
      ...(state.build ? { fromTree: state.build.tree, fromShort: state.build.short } : {}),
      ...(state.desktopBuild ? { fromDesktopTree: state.desktopBuild.tree, fromDesktopShort: state.desktopBuild.short } : {}),
      ...(want ? { want } : {}),
    });
    this.write(state);
    const build = state.desktopBuild ?? state.build;
    const running = [state.desktopBuild && `the GPUI app on ${state.desktopBuild.short}`, state.build && `the Swift app on ${state.build.short}`].filter(Boolean).join(', ');
    return { ...(build ? { build } : {}), ...(running ? { running } : {}), ...(want ? { waitingFor: want.short } : {}) };
  }

  private wanted(threadId: string, commit?: string): Watch['want'] {
    const git = this.deps.git ?? realGit;
    let repo: string | undefined;
    try {
      repo = this.deps.runner.get(threadId).cwd;
    } catch {
      return undefined;
    }
    if (!repo) return undefined;
    const full = commit?.trim() ? git.resolve(repo, commit.trim()) : (git.resolve(repo, 'refs/heads/main') ?? git.resolve(repo, 'refs/heads/master'));
    if (!full) return undefined;
    const trees: Partial<Record<AppKind, string>> = {};
    for (const app of ['mac', 'desktop'] as const) {
      const t = git.tree?.(repo, full, APP_DIRS[app]);
      if (t) trees[app] = t;
    }
    return { commit: full, short: full.slice(0, 9), repo, ...(Object.keys(trees).length ? { trees } : {}) };
  }

  isWatching(threadId: string): boolean {
    return this.read().watching.some((w) => w.threadId === threadId);
  }

  // An app's `hello`, with the build it's running.
  appHello(build: AppBuild, app: AppKind = 'mac'): void {
    const state = this.read();
    const { runner, log, away } = this.deps;
    const git = this.deps.git ?? realGit;
    const now: Watch[] = [];
    const kept: Watch[] = [];
    const older: Watch[] = [];
    // One git question per wanted commit, however many threads wait on it.
    const asked = new Map<string, boolean | 'busy' | undefined>();
    const has = (want: NonNullable<Watch['want']>) => {
      if (want.trees?.[app] === build.tree) return true;
      // By commit alone: a thread's worktrees share one repo's objects.
      const key = want.commit;
      if (!asked.has(key)) asked.set(key, git.contains(want.repo, want.commit, build.commit));
      return asked.get(key);
    };
    for (const watch of state.watching) {
      // This app on another build than the one a handed-over thread was
      // due to hear about (rolled back, or a newer one): that's no longer
      // news. If this one is, it's set again below.
      const stale = watch.due && (watch.dueApp ?? 'mac') === app && watch.due.tree !== build.tree;
      const { due: _d, dueApp: _a, ...rest } = watch;
      const w: Watch = stale ? rest : watch;
      const known = app === 'desktop' ? w.fromDesktopTree : w.fromTree;
      const other = app === 'desktop' ? w.fromTree : w.fromDesktopTree;
      // A build of an app the watch had no build of counts only when it
      // knew neither app's: else the request was about the other one (and
      // the GPUI app's first hello with a build isn't a restart).
      const counts = known !== undefined ? known !== build.tree : other === undefined;
      if (!counts) kept.push(w);
      // Git too slow to say: unchanged, so the next hello asks again.
      else if (w.want && has(w.want) === 'busy') kept.push(w);
      // A new build, but one without the commit it's waiting for: keep
      // waiting, from this build, so a reconnect on it isn't news again.
      else if (w.want && has(w.want) === false) {
        const moved = app === 'desktop' ? { fromDesktopTree: build.tree, fromDesktopShort: build.short } : { fromTree: build.tree, fromShort: build.short };
        kept.push({ ...w, ...moved });
        if (runner.has(w.threadId)) older.push(w);
      } else if (runner.has(w.threadId)) now.push(w);
      // Finishing a turn on the old runner after a handover: told when it
      // comes across (THREADBEAR-5).
      else if (away?.(w.threadId)) kept.push({ ...w, due: build, dueApp: app });
      else log.info('dropped an app restart watch for a thread that has gone', { threadId: w.threadId });
    }
    if (app === 'desktop') state.desktopBuild = build;
    else state.build = build;
    state.watching = kept;
    this.write(state);
    for (const w of older) {
      try {
        runner.note(w.threadId, `${appName(app)} restarted onto ${build.short}, which doesn't have ${w.want!.short} yet. Still waiting.`);
      } catch (e) {
        log.warn('could not note an older app build', { threadId: w.threadId, error: String(e) });
      }
    }
    for (const w of now) this.tell(w, build, app);
  }

  // A thread a draining runner has handed over: if the app came back
  // while it was over there, it hears now.
  adopted(threadId: string): void {
    const state = this.read();
    const w = state.watching.find((x) => x.threadId === threadId && x.due);
    if (!w?.due) return;
    state.watching = state.watching.filter((x) => x !== w);
    this.write(state);
    this.tell(w, w.due, w.dueApp ?? 'mac');
  }

  private tell(w: Watch, build: AppBuild, app: AppKind): void {
    const { runner, log, clock } = this.deps;
    try {
      const thread = runner.get(w.threadId);
      const age = clock.now() - Date.parse(w.requestedAt);
      const why = thread.archivedAt
        ? 'this thread is archived'
        : !(age < MAX_AGE_MS)
          ? 'the request is more than a day old'
          : undefined;
      const fromShort = app === 'desktop' ? w.fromDesktopShort : w.fromShort;
      let note = `${appName(app)} restarted: ${fromShort ?? 'an earlier build'} to ${build.short}`;
      if (why) note += `\n\nNot carrying on by itself: ${why}.`;
      runner.note(w.threadId, note);
      if (why) return;
      const head = `The ${appName(app)} has restarted onto ${build.short} (${build.commit}), as you asked to hear.`;
      runner.send(w.threadId, w.text ? `${head}\n\n${w.text}` : `${head} Check your change in the running app.`, [], { origin: 'runner' });
      log.info('told a thread the app restarted', { threadId: w.threadId, build: build.short, app });
    } catch (e) {
      log.warn('could not tell a thread the app restarted', { threadId: w.threadId, error: String(e) });
    }
  }

  private read(): SavedState {
    try {
      const saved = JSON.parse(fs.readFileSync(appRestartsPath(this.deps.home), 'utf8')) as Partial<SavedState>;
      return {
        ...(saved.build ? { build: saved.build } : {}),
        ...(saved.desktopBuild ? { desktopBuild: saved.desktopBuild } : {}),
        watching: Array.isArray(saved.watching) ? saved.watching : [],
      };
    } catch {
      return { watching: [] };
    }
  }

  private write(state: SavedState): void {
    const file = appRestartsPath(this.deps.home);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }
}
