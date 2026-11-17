// Year-long tokens (docs/protocol.md, Accounts, "Year-long tokens"). A
// Claude sign-in lasts about 28 days from Claude Code 2.1.318; a token from
// `claude setup-token` lasts a year. Mike opts a login in with Year-long
// token… on its row in Usage: the app runs `claude setup-token` in Terminal
// and writes threadbear-token.json in that login's own folder (0600):
// { token, madeAt }. The runner passes the token to that login's CLI as
// CLAUDE_CODE_OAUTH_TOKEN (cliEnv), which takes over from its Keychain
// sign-in, and nowhere else: not to the app, the log, Convex or another
// login. Claude Code keeps it out of the shells its tools run.
//
// Not settings.json's env: Mike's logins share one settings.json through
// symlinks, so a token there would make every login the same account.
import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_FILE = 'threadbear-token.json';
// What `claude setup-token` makes: "a one-year OAuth token" (Claude Code's
// authentication docs). The CLI can't say when one ends (`auth status`
// shows any token as signed in, with no end), so the runner counts it.
export const TOKEN_LIFETIME_MS = 365 * 24 * 3600_000;

export type YearToken = { token: string; madeAt?: string };

// The login's token, or undefined when it has none or the file isn't one.
export function readYearToken(configDir: string): YearToken | undefined {
  if (!configDir) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(path.join(configDir, TOKEN_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  const o = v as { token?: unknown; madeAt?: unknown } | null;
  if (!o || typeof o.token !== 'string' || !/^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/.test(o.token)) return undefined;
  const made = typeof o.madeAt === 'string' && Number.isFinite(Date.parse(o.madeAt)) ? new Date(o.madeAt).toISOString() : undefined;
  return { token: o.token, ...(made ? { madeAt: made } : {}) };
}

// When a token made at `madeAt` ends.
export function yearTokenEnds(madeAt: string | undefined): number | undefined {
  const t = madeAt ? Date.parse(madeAt) : NaN;
  return Number.isFinite(t) ? t + TOKEN_LIFETIME_MS : undefined;
}
