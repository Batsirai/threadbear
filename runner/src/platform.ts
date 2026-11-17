// What differs on Windows, in one place (docs/gpui-port/runner-windows-plan.md).
// The rest of src/ asks this file rather than testing process.platform
// itself, so the Windows branches are easy to find and to test. Started
// from Keith's (platima) Windows port, with the data folder moved out of
// Roaming.

import fs from 'node:fs';
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

// A path's real form, the one to compare two paths by. On macOS and Linux
// that is fs.realpathSync, exactly as before. On Windows it is the native
// one (GetFinalPathNameByHandle): the JS one resolves links but leaves the
// 8.3 short names (C:\Users\RUNNER~1, which is how GitHub's runners spell
// TEMP, and how any profile folder longer than eight characters can turn
// up in a cwd) and the case as they were given, while git and the files
// Windows hands back use the long form, so two spellings of one folder
// compared as two. Throws when the path isn't there, as realpathSync does.
type RealProbe = { platform?: NodeJS.Platform; native?: (p: string) => string; plain?: (p: string) => string };

export function realPathSync(p: string, q: RealProbe = {}): string {
  if ((q.platform ?? process.platform) === 'win32') return (q.native ?? fs.realpathSync.native)(p);
  return (q.plain ?? fs.realpathSync)(p);
}

// The same, without throwing. When the path isn't there, macOS and Linux
// give it back as it was; Windows makes its nearest folder that is there
// real and keeps the rest, so a path to a file about to be made still
// compares with the folder it will be in.
export function realPath(p: string, q: RealProbe = {}): string {
  try {
    return realPathSync(p, q);
  } catch {
    // not there, or not readable
  }
  const platform = q.platform ?? process.platform;
  if (platform !== 'win32') return p;
  const P = path.win32;
  let rest = '';
  for (let d = p; ; ) {
    const up = P.dirname(d);
    if (up === d) return p;
    rest = rest ? P.join(P.basename(d), rest) : P.basename(d);
    d = up;
    try {
      return P.join(realPathSync(d, q), rest);
    } catch {
      // one folder up
    }
  }
}

// A path with forward slashes whatever the platform, for text a person reads
// (messages name files as ./tools/x.sh) and for words a shell takes. It
// changes nothing on macOS and Linux, where path.sep is already /.
export function slashes(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}
