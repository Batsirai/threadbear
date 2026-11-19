// Whether Mike is at this Mac: the Mac app is connected and he's used the
// keyboard or mouse in the last AT_MAC_IDLE_MS. The phone only buzzes while
// he isn't (docs/convex-backend.md, "Notifications and presence"), so a
// thread needing him while he's at his desk shows on the Mac alone, and
// reaches his phone if he walks away without seeing to it.
import { execFile } from 'node:child_process';
import { win32Helper } from './win32-helper.ts';

export const AT_MAC_IDLE_MS = 2 * 60_000;

// Time since the last keyboard or mouse event, from IOKit's HIDIdleTime
// (nanoseconds). Undefined if it can't be read. Asynchronous: ioreg walks
// the IORegistry, which takes a second or two on a Mac busy rendering, and
// a synchronous run froze the whole runner for that long every 15 seconds.
// On Windows the runner's helper asks GetLastInputInfo, for the session the
// runner runs in (win32-helper.ps1, idle).
export function hidIdleMs(): Promise<number | undefined> {
  if (process.platform === 'win32') return win32Helper().ask('idle').then(parseIdle, () => undefined);
  // IOKit is a Mac's; a Linux runner has no idle time to read.
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'], { encoding: 'utf8', timeout: 5000 }, (_err, stdout) => {
      const ns = stdout?.match(/"HIDIdleTime" = (\d+)/)?.[1];
      resolve(ns === undefined ? undefined : Number(ns) / 1_000_000);
    });
  });
}

// Whether this user's screen is locked, from the console session IOKit
// lists (CGSSessionScreenIsLocked). A Touch ID prompt can't show over the
// lock screen, and there the Secure Enclave's SSH provider hands back an
// empty signature as if it had signed (release/2026-11-19, signed eight
// minutes after the screen saver locked the Mac while HIDIdleTime still
// said someone was there). False off a Mac, or when it can't be read: the
// release's own check (upstream.ts selfCheck) still stops a bad signature.
export function screenLocked(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1', '-k', 'IOConsoleUsers'], { encoding: 'utf8', timeout: 5000 }, (_err, stdout) => {
      resolve(parseScreenLocked(stdout ?? '', process.getuid?.() ?? -1));
    });
  });
}

// IOConsoleUsers' sessions are {"key"=value,...} dicts on one line; the
// one for `uid` says "CGSSessionScreenIsLocked"=Yes while it's locked (and
// leaves the key out when it isn't).
export function parseScreenLocked(ioreg: string, uid: number): boolean {
  const line = ioreg.split('\n').find((l) => l.includes('"IOConsoleUsers"')) ?? '';
  for (const session of line.match(/\{[^{}]*\}/g) ?? []) {
    if (!new RegExp(`"kCGSSessionUserIDKey"=${uid}(?![0-9])`).test(session)) continue;
    return /"CGSSessionScreenIsLocked"=Yes/.test(session);
  }
  return false;
}

export function isAtMac(appConnected: boolean, idleMs: number | undefined): boolean {
  return appConnected && idleMs !== undefined && idleMs < AT_MAC_IDLE_MS;
}

// The helper's answer to idle: whole milliseconds, or undefined.
export function parseIdle(text: string): number | undefined {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;
}
