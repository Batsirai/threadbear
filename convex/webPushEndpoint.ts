// Which UnifiedPush endpoints a phone may register (phone:registerDevice,
// platform "webpush", API 93) and push.ts will post to. The F-Droid build of
// the Android app has no Firebase: its notifications come through a
// UnifiedPush distributor on the phone (ntfy and the like), whose server
// gives it an https address that this backend posts each notification to
// itself, with no relay in between (docs/push-relay.md, "UnifiedPush").
//
// A phone with a pairing token chooses that address, so it mustn't be able to
// point this deployment at something private: only https, no credentials in
// it, no localhost, and no IP address in a private, loopback, link-local or
// otherwise special range. push.ts also looks the name up before each send
// and checks every address it resolves to (a name can point anywhere), and
// never follows a redirect. Not "use node", so the mutation can use it too.

export const WEB_PUSH_ENDPOINT_MAX = 1024;
// The connector's keys, base64url without padding (RFC 8291): an uncompressed
// P-256 point (65 bytes) and a 16-byte auth secret.
export const P256DH = /^[A-Za-z0-9_-]{87}$/;
export const AUTH_SECRET = /^[A-Za-z0-9_-]{22}$/;

/** Why this endpoint can't be used, or null when it can. */
export function endpointProblem(endpoint: string): string | null {
  if (endpoint.length > WEB_PUSH_ENDPOINT_MAX) return 'too long';
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'https:') return 'not https';
  if (u.username || u.password) return 'has a user or password';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal|home\.arpa|lan)$/.test(host)) return 'a private name';
  if (isIpLiteral(host) && privateAddress(host)) return 'a private address';
  return null;
}

export const isIpLiteral = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/**
 * True for an address this deployment shouldn't post to: IPv4 private,
 * loopback, link-local, shared (CGNAT), benchmarking, multicast and reserved
 * ranges, and IPv6 loopback, unspecified, unique-local, link-local,
 * multicast, and anything mapped or translated from a private IPv4 one.
 * Anything it can't read counts as private.
 */
export function privateAddress(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [p, q, r] = v4.slice(1, 4).map(Number);
    if (v4.slice(1).some((x) => Number(x) > 255)) return true;
    return p === 0 || p === 10 || p === 127 || p >= 224
      || (p === 100 && q >= 64 && q <= 127)
      || (p === 169 && q === 254)
      || (p === 172 && q >= 16 && q <= 31)
      || (p === 192 && q === 168)
      || (p === 192 && q === 0 && (r === 0 || r === 2))
      || (p === 198 && (q === 18 || q === 19))
      || (p === 198 && q === 51 && r === 100)
      || (p === 203 && q === 0 && r === 113);
  }
  if (!a.includes(':')) return true;
  // An IPv4 address inside an IPv6 one (::ffff:10.0.0.1, 64:ff9b::10.0.0.1).
  const tail = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) return privateAddress(tail[1]) || !/^(::ffff:|::|64:ff9b::)/.test(a);
  const groups = expand(a);
  if (!groups) return true;
  const [g0] = groups;
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8
  // ::ffff:a.b.c.d and 64:ff9b:: written in hex: check the IPv4 inside.
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const nat64 = g0 === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
  if (mapped || nat64) return privateAddress(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  // 2001:db8::/32 (documentation) and 100::/64 (discard).
  if (g0 === 0x2001 && groups[1] === 0x0db8) return true;
  if (g0 === 0x100 && groups.slice(1, 4).every((g) => g === 0)) return true;
  return false;
}

function expand(a: string): number[] | null {
  const parts = a.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (parts.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}
