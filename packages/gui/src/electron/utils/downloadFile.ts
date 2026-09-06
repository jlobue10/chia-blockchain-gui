import { net } from 'electron';
import { promises as fs, createWriteStream, type WriteStream } from 'node:fs';

import debug from 'debug';

import type Headers from '../../@types/Headers';

import fileExists from './fileExists';
import { toFetchableUrl } from './ipfsGateway';
import isValidURL from './isValidURL';

const log = debug('chia-gui:downloadFile');

class WriteStreamPromise {
  private stream: WriteStream;

  private writePromises: Promise<void>[] = [];

  constructor(
    private path: string,
    overrideFile = false,
  ) {
    this.stream = createWriteStream(path, {
      flags: overrideFile ? 'w' : 'wx', // w - override if exists, wx - fail if exists
    });
  }

  write(chunk: Buffer) {
    const promise = new Promise<void>((resolve, reject) => {
      this.stream.write(chunk, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

    this.writePromises.push(promise);

    return promise;
  }

  async close() {
    try {
      await Promise.all(this.writePromises);
    } catch (error) {
      log('Error while writing to stream', error);
    }

    return new Promise<void>((resolve, reject) => {
      this.stream.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  on(event: string, listener: (...args: any[]) => void) {
    return this.stream.on(event, listener);
  }
}

export const MAX_FILE_SIZE_EXCEEDED_ERROR = 'Maximum file size exceeded';

const INACTIVITY_TIMEOUT_ERROR_PREFIX = 'Request timed out after';
const DOWNLOAD_DEADLINE_ERROR_PREFIX = 'Request exceeded the';

/** Matches the messages of both timeout errors below, including messages that
 * earlier sessions persisted into cache `-info` files. */
export function isDownloadTimeoutError(message: string): boolean {
  return message.startsWith(INACTIVITY_TIMEOUT_ERROR_PREFIX) || message.startsWith(DOWNLOAD_DEADLINE_ERROR_PREFIX);
}

const HTTP_ERROR_PREFIX = 'HTTP error: ';

// Statuses below 500 that still describe a passing condition of the host
// rather than of the resource. 403 is included because Cloudflare fronts the
// public IPFS gateways (ipfs.io, and nftstorage.link which now redirects to
// it) and answers with a 403 "Just a moment..." bot challenge whenever it is
// in a challenging mood; the file is still there and the next request often
// succeeds. 408/425/429 are the timeout, too-early and rate-limit statuses.
const TRANSIENT_HTTP_STATUSES = new Set([403, 408, 425, 429]);

// Server errors that describe the host itself rather than a passing
// condition: it does not implement the request (501) or the protocol (505).
// Every other 5xx — 500, 502, 503, 504, 507, Cloudflare's 52x — is a gateway
// or origin that may well answer next time.
const PERMANENT_HTTP_STATUSES = new Set([501, 505]);

// Chromium network errors that are properties of the URL, not of the moment: a
// scheme or port the client refuses, a URL it cannot parse, a redirect it will
// not follow. Re-requesting these could only ever fail the same way, so they
// settle like a 404. Certificate errors (net::ERR_CERT_*) are matched by prefix
// below for the same reason. Every other net::ERR_* code — connection resets,
// QUIC/HTTP2 protocol errors, net::ERR_BLOCKED_BY_RESPONSE for a challenge page
// that carries a Cross-Origin-Resource-Policy header — keeps the benefit of the
// doubt. So does a name that did not resolve: Chromium reports that for an
// offline machine, a resolver timeout or a sleep/wake glitch as readily as for
// a name that does not exist, and settling it would leave every preview a user
// first opened offline broken until the cache is cleared. The retry schedule
// in CacheManager bounds what a name that truly never resolves can cost.
const PERMANENT_NET_ERRORS = new Set([
  'net::ERR_INVALID_URL',
  'net::ERR_DISALLOWED_URL_SCHEME',
  'net::ERR_UNKNOWN_URL_SCHEME',
  'net::ERR_UNSAFE_PORT',
  'net::ERR_UNSAFE_REDIRECT',
  'net::ERR_INVALID_REDIRECT',
  'net::ERR_TOO_MANY_REDIRECTS',
  'net::ERR_BLOCKED_BY_CLIENT',
  'net::ERR_BLOCKED_BY_ADMINISTRATOR',
  'net::ERR_FILE_NOT_FOUND',
]);

/** Whether a persisted download failure describes a condition that can clear
 * on its own — a timeout, a gateway/server error, a rate limit or bot
 * challenge, or a Chromium network error — as opposed to a resource that is
 * gone for good (404, 410), a host that cannot serve it (unresolvable name,
 * bad certificate, 501) or a local policy (size cap). CacheManager retries
 * these after a cooling-off period instead of keeping the entry poisoned
 * until the whole cache is cleared. Every URL this classifies comes from NFT
 * data the minter wrote, so a failure that can never clear must settle: a
 * retry-eligible verdict on it would re-probe the minter's host for as long
 * as the wallet is open. */
export function isTransientDownloadError(message: string): boolean {
  if (isDownloadTimeoutError(message)) {
    return true;
  }

  if (message.startsWith('net::ERR_')) {
    return !PERMANENT_NET_ERRORS.has(message) && !message.startsWith('net::ERR_CERT_');
  }

  if (message.startsWith(HTTP_ERROR_PREFIX)) {
    const status = Number.parseInt(message.slice(HTTP_ERROR_PREFIX.length), 10);
    return (status >= 500 && !PERMANENT_HTTP_STATUSES.has(status)) || TRANSIENT_HTTP_STATUSES.has(status);
  }

  return false;
}

type DownloadFileOptions = {
  timeout?: number;
  maxDuration?: number; // absolute cap on the whole transfer
  signal?: AbortSignal;
  maxSize?: number; // values <= 0 disable the size limit
  onProgress?: (progress: number, size: number, downloadedSize: number) => void;
  overrideFile?: boolean;
};

export default async function downloadFile(
  url: string,
  localPath: string,
  {
    timeout = 30_000,
    maxDuration = 30 * 60 * 1000,
    signal,
    maxSize = 100 * 1024 * 1024,
    onProgress,
    overrideFile = false,
  }: DownloadFileOptions = {},
): Promise<Headers> {
  if (!isValidURL(url)) {
    throw new Error('Invalid URL');
  }

  // A queued download can be aborted (invalidation, cache directory change)
  // before the concurrency limiter starts it. Without this check the transfer
  // would still run, hold a download slot, and could settle the URL with a
  // permanent timeout error. The error matches the mid-flight abort message so
  // the cache treats it as retryable.
  if (signal?.aborted) {
    throw new Error('Request aborted');
  }

  const tempFilePath = `${localPath}.tmp`;
  // ipfs:// URIs are fetched through an HTTPS gateway when the user has
  // enabled it — Electron's net stack cannot request the ipfs scheme, and
  // with the option off toFetchableUrl refuses the fetch outright. Only
  // this outgoing request uses the translated URL; callers keep the original
  // URI as the cache key.
  const request = net.request(toFetchableUrl(url));
  const outputStream = new WriteStreamPromise(tempFilePath, overrideFile);

  // set when we abort the request ourselves, so abort events can be reported
  // with the real reason instead of a generic aborted error
  let abortError: Error | undefined;

  function abortRequest() {
    request.abort();
  }

  // Timeouts must not report the generic aborted error: the cache retries
  // aborted downloads on every access, so a stalled host would be retried
  // (and stall again) forever instead of settling as a failed download.
  function abortWithError(error: Error) {
    abortError = error;
    request.abort();
  }

  let timeoutId: NodeJS.Timeout | null = null;

  // the timeout is an inactivity timeout - it is reset every time data
  // arrives, so slow hosts serving large files (videos) are not cut off mid
  // transfer while a stalled connection still fails fast
  function resetTimeout() {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(
      () => abortWithError(new Error(`${INACTIVITY_TIMEOUT_ERROR_PREFIX} ${timeout}ms of inactivity`)),
      timeout,
    );
  }

  // absolute deadline for the whole transfer — the inactivity timeout alone
  // would let a host trickling bytes hold a download slot forever
  const maxDurationTimeoutId = setTimeout(
    () => abortWithError(new Error(`${DOWNLOAD_DEADLINE_ERROR_PREFIX} ${maxDuration}ms download deadline`)),
    maxDuration,
  );

  return new Promise<Headers>((resolve, reject) => {
    let downloadedSize = 0;

    let headers: Headers;
    let promiseFulfilled = false;

    async function resolvePromise(succeeded: boolean, error?: Error) {
      try {
        if (promiseFulfilled) {
          log('Promise already fulfilled', url);
          return;
        }

        promiseFulfilled = true;

        // cleanup listeners
        if (signal) {
          signal.removeEventListener('abort', abortRequest);
        }

        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        clearTimeout(maxDurationTimeoutId);

        await outputStream.close();

        // resolve promise
        if (succeeded) {
          log('Download succeeded', url);

          // rename temp file to local path
          if (!overrideFile) {
            const isFileExists = await fileExists(localPath);
            if (isFileExists) {
              throw new Error('File already exists');
            }
          }

          await fs.rename(tempFilePath, localPath);
          resolve(headers);
          return;
        }

        throw error ?? new Error('Unknown error');
      } catch (e) {
        log('Download failed', url, (e as Error)?.message);
        // The temp file may never have been created (the stream failed to
        // open) or may already be gone. Cleanup must not decide whether the
        // promise settles: this runs from fire-and-forget event handlers, so a
        // throw here would leave the caller — and its download slot — waiting
        // forever.
        await fs.unlink(tempFilePath).catch(() => {});
        reject(e);
      }
    }

    request.on('response', (response) => {
      const { statusCode } = response;
      if (statusCode < 200 || statusCode >= 300) {
        resolvePromise(false, new Error(`HTTP error: ${response.statusCode}`));
        request.abort();
        return;
      }

      headers = response.headers;

      // try to cancel request if file size is too large and content-length header is available, otherwise abort request during download
      const contentLengthHeader = response.headers['content-length'];
      const contentLength = Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader;

      let fileSize: number | undefined;
      if (contentLength) {
        const size = Number.parseInt(contentLength, 10);
        if (!Number.isNaN(size)) {
          fileSize = size;
          if (maxSize > 0 && size > maxSize) {
            abortError = new Error(MAX_FILE_SIZE_EXCEEDED_ERROR);
            request.abort();
            return;
          }
        }
      }

      response.on('data', (chunk) => {
        downloadedSize += chunk.byteLength;
        resetTimeout();

        if (maxSize > 0 && downloadedSize > maxSize) {
          abortError = new Error(MAX_FILE_SIZE_EXCEEDED_ERROR);
          request.abort();
          return;
        }

        outputStream.write(chunk).catch((error) => {
          resolvePromise(false, error);
        });

        // send progress event only when we know the file size
        if (onProgress && fileSize !== undefined && fileSize > 0) {
          const progress = Math.min((downloadedSize / fileSize) * 100, 100);
          onProgress(progress, fileSize, downloadedSize);
        }
      });

      response.on('error', (error = new Error('Unknown response error')) => {
        resolvePromise(false, error);
      });

      response.on('aborted', () => {
        resolvePromise(false, abortError ?? new Error('Response aborted'));
      });

      response.on('end', () => {
        resolvePromise(true);
      });
    });

    request.on('abort', () => {
      resolvePromise(false, abortError ?? new Error('Request aborted'));
    });

    request.on('error', (error = new Error('Unknown request error')) => {
      resolvePromise(false, error);
    });

    // A write stream that cannot open its file (missing cache directory, no
    // permission, too many open files) reports it as an 'error' event; with no
    // listener that is an uncaught exception in the main process.
    outputStream.on('error', (error: Error = new Error('Unknown write error')) => {
      resolvePromise(false, error);
      request.abort();
    });

    if (signal) {
      signal.addEventListener('abort', abortRequest);
    }

    resetTimeout();

    request.end();
  });
}
