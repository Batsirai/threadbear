// presence: whether Mike is at this Mac, and whether its screen is locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAtMac, parseScreenLocked } from '../../src/presence.ts';

test('isAtMac: the app connected and input in the last two minutes', () => {
  assert.equal(isAtMac(true, 1000), true);
  assert.equal(isAtMac(false, 1000), false);
  assert.equal(isAtMac(true, 3 * 60_000), false);
  assert.equal(isAtMac(true, undefined), false);
});

// release/2026-11-19 was signed over the lock screen, where the Secure
// Enclave hands back an empty signature: release signing waits for this.
test("parseScreenLocked: this user's console session, as ioreg prints it", () => {
  const locked = '+-o Root  <class IORegistryEntry>\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionUserIDKey"=501})\n';
  const open = '      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserIDKey"=501})\n';
  const other = '      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=No,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionUserIDKey"=502},{"kCGSSessionUserIDKey"=501,"kCGSSessionOnConsoleKey"=Yes})\n';
  assert.equal(parseScreenLocked(locked, 501), true);
  assert.equal(parseScreenLocked(open, 501), false);
  assert.equal(parseScreenLocked(other, 501), false, "another user's locked session isn't this one");
  assert.equal(parseScreenLocked(other, 502), true);
  assert.equal(parseScreenLocked(locked, 50), false, 'uid 50 is not 501');
  assert.equal(parseScreenLocked('', 501), false);
});
