// Which page an address is (route.ts). Apart from the browser, so a test
// can run it.

export type RailView = 'scheduled' | 'projects' | 'runners' | 'usage';
export type Route = { page: 'list' } | { page: 'new' } | { page: 'thread'; threadId: string } | { page: 'share'; slug: string } | { page: RailView; id?: string };

// A path part as text, or undefined for a bad % escape (/s/%zz): that's the
// list, as decodeURIComponent throwing there stopped the app loading at all.
function decode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

export function parsePath(pathname: string): Route {
  const s = pathname.match(/^\/s\/([^/]+)\/?$/);
  if (s) {
    const slug = decode(s[1]);
    return slug === undefined ? { page: 'list' } : { page: 'share', slug };
  }
  const m = pathname.match(/^\/t\/([^/]+)\/?$/);
  if (m) {
    const threadId = decode(m[1]);
    return threadId === undefined ? { page: 'list' } : { page: 'thread', threadId };
  }
  if (/^\/new\/?$/.test(pathname)) return { page: 'new' };
  const v = pathname.match(/^\/(scheduled|projects|runners|usage)(?:\/([^/]+))?\/?$/);
  if (v) {
    if (!v[2]) return { page: v[1] as RailView };
    const id = decode(v[2]);
    return id === undefined ? { page: 'list' } : { page: v[1] as RailView, id };
  }
  return { page: 'list' };
}
