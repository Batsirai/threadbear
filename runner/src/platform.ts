// What differs on Windows, in one place (docs/gpui-port/runner-windows-plan.md).
// The rest of src/ asks this file rather than testing process.platform
// itself, so the Windows branches are easy to find and to test. Started
// from Keith's (platima) Windows port, with the data folder moved out of
// Roaming.

import os from 'node:os';
import path from 'node:path';

type Probe = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string };

export const IS_WINDOWS = process.platform === 'win32';

// %LOCALAPPDATA%, or where Windows puts it when the variable is missing. A
// home other than this user's (a test's temp folder) gets its own, so a
// test can never reach the real data dir through the variable.
function localAppData(p: Probe): string {
  const home = p.home ?? os.homedir();
  const env = p.env ?? (home === os.homedir() ? process.env : {});
  return env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
}

// The data dir. macOS and Linux keep ~/Library/Application Support/Threadbear
// (docs/protocol.md). Windows uses %LOCALAPPDATA%\Threadbear, not Roaming:
// a roaming profile copies Roaming to a server at every sign-out, and the
// data dir holds every transcript (the 9 Nov audit). The GPUI app's
// default_home (desktop/client/src/config.rs) has to say the same.
export function dataDirFor(p: Probe = {}): string {
  if ((p.platform ?? process.platform) === 'win32') return path.win32.join(localAppData(p), 'Threadbear');
  return path.join(p.home ?? os.homedir(), 'Library', 'Application Support', 'Threadbear');
}

// Where the runner writes its log: ~/Library/Logs on a Mac (and Linux, which
// kept the Mac's names), the data dir's Logs folder on Windows.
export function logFileFor(p: Probe = {}): string {
  if ((p.platform ?? process.platform) === 'win32') return path.win32.join(localAppData(p), 'Threadbear', 'Logs', 'threadbear-runner.log');
  return path.join(p.home ?? os.homedir(), 'Library', 'Logs', 'threadbear-runner.log');
}

// The name of a program file: claude.exe on Windows, claude elsewhere.
export function exeName(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}
