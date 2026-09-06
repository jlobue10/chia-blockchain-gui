import type Metadata from '../@types/Metadata';

export const CHECKSUM_MISMATCH_ERROR = 'Checksum mismatch';

// Bounds on one NFT's walk through its metadata URIs. The list is written by
// the minter with no length cap, and every attempt takes one of the cache's
// shared download slots for as long as the host keeps the connection alive,
// so a long list of dead or slow hosts must not cost the full per-fetch
// duration each — the confirmation dialog's resolver bounds the identical
// walk the same way (electron/commands/parseCommandDisplay.ts). Real NFTs
// record two or three copies; the cap leaves room for that and no more.
export const MAX_METADATA_URI_ATTEMPTS = 5;
export const METADATA_URI_BUDGET_MS = 60_000;

export type FetchMetadata = (uri: string, hash: string | undefined) => Promise<Metadata>;

/**
 * Fetches an NFT's metadata from the first of its metadata URIs that serves
 * it. NFTs commonly record several copies of their metadata (an HTTPS
 * gateway URL and an ipfs:// URI, say); a host that is down, rate limiting or
 * challenging the request must not hide the metadata while another copy is
 * reachable — data files already fall through their URI list this way.
 *
 * The walk is bounded: at most MAX_METADATA_URI_ATTEMPTS URIs are tried, and
 * none is started once METADATA_URI_BUDGET_MS have passed since the first
 * attempt *settled*. The clock starts then rather than at the call, because
 * the first attempt may spend a long time queued behind the cache's shared
 * download limiter during a gallery-wide pass — time no host consumed, which
 * must not be charged against the fallbacks that were never tried.
 * Without an on-chain hash there is nothing to tell one copy from another,
 * so further URIs would add fetches without adding confidence — only the
 * first is tried, as before this walk existed. (The data-file verifier and
 * the confirmation dialog refuse to fetch at all in that case.)
 *
 * When every URI fails, a checksum mismatch outranks a download failure: a
 * file that does not match the on-chain hash must be reported as such, not
 * as merely unavailable. Otherwise the first failure is reported, since the
 * first URI is the one the minter considered canonical.
 */
export default async function fetchMetadataFromUris(
  uris: string[] | undefined,
  hash: string | undefined,
  fetchOne: FetchMetadata,
): Promise<Metadata> {
  if (!uris || uris.length === 0) {
    throw new Error('No metadata URI');
  }

  const candidates = hash ? uris.slice(0, MAX_METADATA_URI_ATTEMPTS) : uris.slice(0, 1);

  let deadline: number | undefined;
  let firstError: Error | undefined;
  let mismatchError: Error | undefined;

  for (const uri of candidates) {
    if (deadline !== undefined && Date.now() >= deadline) {
      break;
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- the URIs are fallbacks for each other, tried in order
      return await fetchOne(uri, hash);
    } catch (e) {
      const error = e as Error;
      // the budget for the fallbacks opens when the first attempt settles
      deadline ??= Date.now() + METADATA_URI_BUDGET_MS;
      firstError ??= error;
      if (!mismatchError && error.message === CHECKSUM_MISMATCH_ERROR) {
        mismatchError = error;
      }
    }
  }

  throw mismatchError ?? firstError ?? new Error('No metadata URI');
}
