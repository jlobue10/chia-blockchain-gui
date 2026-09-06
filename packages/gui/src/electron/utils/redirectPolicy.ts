import type { ClientRequest } from 'electron';

import isValidURL from './isValidURL';

// Redirect targets are chosen by whoever answers the request: for an NFT
// resource that is the minter's host, or a gateway relaying its content. A
// redirect is therefore held to the same rule as the URL that was requested:
// https, to a host the structural check accepts. The one exception is a
// request that already went to a plain-http gateway on this machine (a local
// IPFS node): it may redirect within its own origin, as such nodes do to
// canonicalize a path, and nowhere else.
export const MAX_REDIRECTS = 5;
export const REDIRECT_REFUSED_ERROR = 'Redirect refused';
export const TOO_MANY_REDIRECTS_ERROR = 'Too many redirects';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackHttpOrigin(parsed: URL): boolean {
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
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

  // isValidURL accepts an ipfs:// URI by validating its gateway form; a
  // redirect, though, names the URL that would be requested next, and the
  // network stack can only request http(s).
  if (to.protocol === 'https:') {
    return isValidURL(toUrl);
  }

  return isLoopbackHttpOrigin(from) && to.origin === from.origin;
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
