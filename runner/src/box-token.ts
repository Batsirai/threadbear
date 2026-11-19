// Box mode's refused token (docs/protocol.md, Box mode, "A refused token"):
// `claude auth status` calls any token signed in, so a dead cloud token only
// shows when a turn is refused (errorKind auth). The runner holds the thread
// (Runner.holdForToken) and this tells the backend (boxes:tokenRefused, which
// kills that token so the card comes back on Mike's Mac), then asks every 30
// seconds for its login's token (boxes:boxCloudToken). One set later than
// the box's own is written where claude-main's CLI reads it, and the thread
// carries on (Runner.tokenReplaced).
//
// Nothing runs while a save holds the box: a tick then waits for the next.
// The token is never logged; the scrubber knows it from the moment it's read.
import type { Logger } from './log.ts';
import type { ActionPost } from './box-mode.ts';
import { readBoxSecrets, setTokenSetAt, writeBoxToken } from './box-mode.ts';
import { rememberToken } from './year-token.ts';

export const TOKEN_POLL_MS = 30_000;

type Timer = { cancel(): void };

export class BoxTokenWatch {
  private o: {
    home: string;
    claudeDir: string;
    key: string;
    post: ActionPost;
    log: Logger;
    setTimeout: (fn: () => void, ms: number) => Timer;
    // A save holds the box: nothing is fetched or written meanwhile.
    held: () => boolean;
    // The thread waiting for a token, if any (its record's waitingForToken).
    waiting: () => boolean;
    // A newer token is on disk: the thread carries on.
    replaced: () => void;
    // A call refused as a bad key: this box no longer has the thread.
    superseded?: (e: unknown) => boolean;
    everyMs?: number;
  };
  private timer?: Timer;
  private reportOwed = false;
  private stopped = false;
  private ticking = false;

  constructor(o: BoxTokenWatch['o']) {
    this.o = o;
  }

  /** A turn was refused: say so, and watch for a newer token. */
  refused(): void {
    this.reportOwed = true;
    this.arm(0);
  }

  /** At start: a thread still waiting from before watches again (its refusal was said then). */
  start(): void {
    if (this.o.waiting()) this.arm(0);
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    this.timer?.cancel();
    this.timer = this.o.setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, ms);
  }

  private own(): number {
    return readBoxSecrets(this.o.home)?.tokenSetAt ?? 0;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      if (!this.o.waiting()) return;
      if (this.o.held()) return this.arm(this.o.everyMs ?? TOKEN_POLL_MS);
      if (this.reportOwed) {
        await this.o.post('mutation', 'boxes:tokenRefused', { key: this.o.key, setAt: this.own() });
        this.reportOwed = false;
      }
      const got = (await this.o.post('action', 'boxes:boxCloudToken', { key: this.o.key })) as { token?: unknown; setAt?: unknown } | null;
      if (got && typeof got.token === 'string' && typeof got.setAt === 'number' && got.setAt > this.own()) {
        rememberToken(got.token);
        if (this.o.held()) return this.arm(this.o.everyMs ?? TOKEN_POLL_MS);
        writeBoxToken(this.o.claudeDir, got.token);
        setTokenSetAt(this.o.home, got.setAt);
        this.o.log.info('box: a newer cloud token is set; carrying on', { setAt: got.setAt });
        this.o.replaced();
        return;
      }
      this.arm(this.o.everyMs ?? TOKEN_POLL_MS);
    } catch (e) {
      if (this.o.superseded?.(e)) return this.stop();
      this.o.log.warn('box: could not check for a newer cloud token; trying again', { error: String((e as Error)?.message ?? e).slice(0, 200) });
      this.arm(this.o.everyMs ?? TOKEN_POLL_MS);
    } finally {
      this.ticking = false;
    }
  }
}
