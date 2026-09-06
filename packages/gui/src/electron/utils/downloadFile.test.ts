import os from 'node:os';
import path from 'node:path';

const mockNetRequest = jest.fn();

jest.mock('electron', () => ({
  net: {
    request: mockNetRequest,
  },
}));

const { default: downloadFile, isTransientDownloadError } =
  jest.requireActual<typeof import('./downloadFile')>('./downloadFile');

describe('downloadFile', () => {
  beforeEach(() => {
    mockNetRequest.mockReset();
  });

  it('does not start a transfer whose signal was aborted while queued', async () => {
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      downloadFile('https://example.com/nft.png', path.join(os.tmpdir(), 'downloadFile-test-nft.png'), {
        signal: abortController.signal,
      }),
    ).rejects.toThrow('Request aborted');

    expect(mockNetRequest).not.toHaveBeenCalled();
  });
});

describe('isTransientDownloadError', () => {
  it.each([
    'Request timed out after 30000ms of inactivity',
    'Request exceeded the 1800000ms download deadline',
    'HTTP error: 500',
    'HTTP error: 502',
    'HTTP error: 503',
    'HTTP error: 504',
    'HTTP error: 507',
    'HTTP error: 520',
    'HTTP error: 522',
    'HTTP error: 429',
    'HTTP error: 408',
    // Cloudflare bot challenge in front of the public IPFS gateways
    'HTTP error: 403',
    'net::ERR_BLOCKED_BY_RESPONSE',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_QUIC_PROTOCOL_ERROR',
    'net::ERR_HTTP2_PROTOCOL_ERROR',
    'net::ERR_INTERNET_DISCONNECTED',
    // offline, or a resolver hiccup, as often as a name that does not exist
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_NAME_RESOLUTION_FAILED',
    // an unknown network error keeps the benefit of the doubt
    'net::ERR_SOMETHING_NEW',
  ])('treats %p as transient', (message) => {
    expect(isTransientDownloadError(message)).toBe(true);
  });

  it.each([
    'HTTP error: 404',
    'HTTP error: 410',
    'HTTP error: 400',
    'HTTP error: 401',
    // the host does not implement the request or the protocol
    'HTTP error: 501',
    'HTTP error: 505',
    'Maximum file size exceeded',
    'Invalid URL',
    'Unknown error',
    'IPFS gateway fetching is disabled',
  ])('treats %p as permanent', (message) => {
    expect(isTransientDownloadError(message)).toBe(false);
  });

  // Every URL that reaches this predicate was written by the NFT's minter, and
  // a "transient" verdict re-probes it for as long as the wallet is open —
  // a failure that is a property of the URL must settle instead.
  it.each([
    'net::ERR_CERT_AUTHORITY_INVALID',
    'net::ERR_CERT_DATE_INVALID',
    'net::ERR_CERT_COMMON_NAME_INVALID',
    'net::ERR_UNSAFE_PORT',
    'net::ERR_DISALLOWED_URL_SCHEME',
    'net::ERR_UNKNOWN_URL_SCHEME',
    'net::ERR_INVALID_URL',
    'net::ERR_BLOCKED_BY_CLIENT',
    'net::ERR_INVALID_REDIRECT',
    'net::ERR_TOO_MANY_REDIRECTS',
  ])('treats the network error %p as permanent', (message) => {
    expect(isTransientDownloadError(message)).toBe(false);
  });
});
