// Year-long tokens (year-token.ts): a login's threadbear-token.json, made
// by the app's Year-long token…, goes to that login's CLI and nowhere else,
// shows on the account as when it was made, and counts a year for the
// sign-in warnings, since `auth status` calls any token signed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { SignInState, ENDING_SOON_MS } from '../../src/sign-in-state.ts';
import { TOKEN_FILE, TOKEN_LIFETIME_MS, readYearToken } from '../../src/year-token.ts';
import { cliEnv } from '../../src/adapters/claude/adapter.ts';
import { discoverAccounts } from '../../src/accounts.ts';
import type { Account } from '../../src/protocol.ts';

const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(90);
const MADE = '2026-11-17T07:00:00.000Z';

function folder(token?: object | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-year-'));
  if (token !== undefined) fs.writeFileSync(path.join(dir, TOKEN_FILE), typeof token === 'string' ? token : JSON.stringify(token), { mode: 0o600 });
  return dir;
}

test('reads a token file: the token and when it was made; anything else is no token', () => {
  assert.deepEqual(readYearToken(folder({ token: TOKEN, madeAt: MADE })), { token: TOKEN, madeAt: MADE });
  assert.deepEqual(readYearToken(folder({ token: TOKEN })), { token: TOKEN });
  assert.equal(readYearToken(folder()), undefined);
  assert.equal(readYearToken(folder('{not json')), undefined);
  assert.equal(readYearToken(folder({ token: 'sk-ant-api03-' + 'a'.repeat(90) })), undefined, 'an API key is not a setup-token');
  assert.equal(readYearToken(folder({ token: TOKEN + '\n; rm -rf ~' })), undefined);
  assert.equal(readYearToken(''), undefined);
});

test("a login's token goes to its own CLI only, never one from the runner's environment", () => {
  const mine = folder({ token: TOKEN, madeAt: MADE });
  const other = folder();
  const a = (id: string, configDir: string, provider: Account['provider'] = 'claude'): Account => ({ id, provider, title: id, configDir });
  const base = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-' + 'b'.repeat(90) };
  assert.equal(cliEnv(a('claude-1', mine), base).CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(cliEnv(a('claude-3', other), base).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'its Keychain sign-in, not the runner\'s token');
  assert.equal(cliEnv(a('codex-1', mine, 'codex'), base).CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('the account says it has a token and when it was made, never the token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-year-accounts-'));
  const one = path.join(root, 'claude-1');
  fs.mkdirSync(one);
  fs.writeFileSync(path.join(one, TOKEN_FILE), JSON.stringify({ token: TOKEN, madeAt: MADE }));
  fs.mkdirSync(path.join(root, 'claude-2'));
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-year-main-'));
  const list = discoverAccounts({ claudeMainDir: main, claudeMainJson: path.join(main, 'none.json'), tokenStatsAccountsDir: root, userHome: os.tmpdir(), pathEnv: '' } as never);
  const byId = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.deepEqual(byId['claude-1'].yearToken, { madeAt: MADE });
  assert.equal(byId['claude-2'].yearToken, undefined);
  assert.ok(!JSON.stringify(list).includes(TOKEN));
});

test("a token login isn't asked the CLI; its end is a year from when it was made, and a new token takes a refusal back", async () => {
  const made = Date.parse(MADE);
  const clock = new FakeClock(made + TOKEN_LIFETIME_MS - ENDING_SOON_MS - 1000);
  const asked: string[] = [];
  const accounts: Account[] = [{ id: 'claude-1', provider: 'claude', title: 'one', configDir: '/x', yearToken: { madeAt: MADE } }];
  const state = new SignInState({ claudePath: 'c', accounts: () => accounts, env: () => ({}), clock, log: nullLogger, exec: async () => (asked.push('x'), JSON.stringify({ loggedIn: true })) });
  await state.checkAll();
  assert.deepEqual(asked, []);
  assert.deepEqual(state.view(accounts[0]), { loginEndsAt: new Date(made + TOKEN_LIFETIME_MS).toISOString() });
  // Refused: out for its hour, until a new token.
  state.noteRefused('claude-1');
  assert.equal(state.view(accounts[0]).signedOut, true);
  accounts[0] = { ...accounts[0], yearToken: { madeAt: new Date(clock.now()).toISOString() } };
  assert.equal(state.view(accounts[0]).signedOut, undefined, 'a new token');
  // Past its year: signed out.
  clock.advance(ENDING_SOON_MS + TOKEN_LIFETIME_MS);
  assert.equal(state.view(accounts[0]).signedOut, true);
  // A token file with no date: no end known, so no warning, and a refusal still holds.
  accounts[0] = { ...accounts[0], yearToken: {} };
  assert.deepEqual(state.view(accounts[0]), {});
  state.stop();
});
