import type { ClientRequest } from 'electron';

import isValidURL from './isValidURL';

// Redirect targets are chosen by whoever answers the request: for an NFT
// resource that is the minter's host, or a gateway relaying its content. A
// redirect is therefore held to the rule the requested URL had to meet —
// https, to a host the structural check accepts — and to one more: a
// redirect names a host the NFT never did, so it may not point at this
// machine or the local network, whatever the scheme, although a minter's
// own https URI to such an address would be accepted as recorded. The one
// exception is a request that already went to a gateway on this machine (a
// local IPFS node, http or https): it may redirect within its own origin, as
// such nodes do to canonicalize a path, and nowhere else.
export const MAX_REDIRECTS = 5;
export const REDIRECT_REFUSED_ERROR = 'Redirect refused';
export const TOO_MANY_REDIRECTS_ERROR = 'Too many redirects';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackOrigin(parsed: URL): boolean {
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && LOOPBACK_HOSTS.has(parsed.hostname);
}

// Whether a host names this machine or a network no NFT resource lives on:
// loopback, link-local, the private ranges, the unspecified and shared
// ranges, and their IPv6 forms (mapped IPv4 included).
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  return (
    a === 0 || // unspecified
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  const v4 = IPV4.exec(host);
  if (v4) {
    return isPrivateIpv4(v4.slice(1).map(Number));
  }

  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1);
    // an IPv4-mapped address, as the URL parser writes it (hex groups) or
    // as it may be typed (dotted)
    const mapped = /^::ffff:(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(v6);
    if (mapped) {
      if (mapped[1]) {
        return isPrivateIpv4(mapped[1].split('.').map(Number));
      }
      const high = parseInt(mapped[2], 16);
      const low = parseInt(mapped[3], 16);
      return isPrivateIpv4([Math.floor(high / 256), high % 256, Math.floor(low / 256), low % 256]);
    }
    return (
      v6 === '::1' ||
      v6 === '::' ||
      v6.startsWith('fe8') ||
      v6.startsWith('fe9') ||
      v6.startsWith('fea') ||
      v6.startsWith('feb') ||
      v6.startsWith('fc') ||
      v6.startsWith('fd')
    );
  }

  return false;
}

export function isAllowedRedirect(fromUrl: string, toUrl: string): boolean {
  if (typeof toUrl !== 'string') {
    return false;
  }

  let from: URL;
  let to: URL;
  try {
    from = new URL(fromUrl);
    to = new URL(toUrl);
  } catch {
    return false;
  }

  // a local gateway may canonicalize within its own origin
  if (isLoopbackOrigin(from) && to.origin === from.origin) {
    return true;
  }

  // isValidURL accepts an ipfs:// URI by validating its gateway form; a
  // redirect, though, names the URL that would be requested next, and the
  // network stack can only request http(s).
  return to.protocol === 'https:' && !isLocalOrPrivateHost(to.hostname) && isValidURL(toUrl);
}

/** Follows a request's redirects one by one, refusing any that leaves the
 * policy above or exceeds MAX_REDIRECTS. The request must have been created
 * with `redirect: 'manual'`; `refuse` is expected to abort it with the given
 * error, which is deliberately not one the cache retries. */
export default function guardRedirects(
  request: Pick<ClientRequest, 'on' | 'followRedirect'>,
  fromUrl: string,
  refuse: (error: Error) => void,
) {
  let hops = 0;
  let currentUrl = fromUrl;

  request.on('redirect', (_statusCode: number, _method: string, redirectUrl: string) => {
    hops += 1;
    if (hops > MAX_REDIRECTS) {
      refuse(new Error(TOO_MANY_REDIRECTS_ERROR));
      return;
    }

    if (!isAllowedRedirect(currentUrl, redirectUrl)) {
      refuse(new Error(REDIRECT_REFUSED_ERROR));
      return;
    }

    currentUrl = redirectUrl;
    request.followRedirect();
  });
}
