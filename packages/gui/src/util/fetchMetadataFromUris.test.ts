import fetchMetadataFromUris, {
  CHECKSUM_MISMATCH_ERROR,
  MAX_METADATA_URI_ATTEMPTS,
  METADATA_URI_BUDGET_MS,
} from './fetchMetadataFromUris';

const METADATA = { name: 'Test NFT' };
const HTTPS_URI = 'https://nftstorage.link/ipfs/bafybeigdyrztest/metadata.json';
const IPFS_URI = 'ipfs://bafybeigdyrztest/metadata.json';

describe('fetchMetadataFromUris', () => {
  // The URI list is minter-authored and uncapped, and every attempt holds a
  // shared download slot for as long as its host keeps the connection alive,
  // so the walk is bounded in attempts and in time.
  it('tries no more than MAX_METADATA_URI_ATTEMPTS URIs', async () => {
    const uris = Array.from({ length: 20 }, (_, i) => `https://host-${i}.example/metadata.json`);
    const fetchOne = jest.fn().mockRejectedValue(new Error('HTTP error: 503'));

    await expect(fetchMetadataFromUris(uris, 'ab', fetchOne)).rejects.toThrow('HTTP error: 503');
    expect(fetchOne).toHaveBeenCalledTimes(MAX_METADATA_URI_ATTEMPTS);
    expect(fetchOne).toHaveBeenLastCalledWith(uris[MAX_METADATA_URI_ATTEMPTS - 1], 'ab');
  });

  it('starts no further attempt once the budget that opened with the first failure is spent', async () => {
    let now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const THIRD_URI = 'https://mirror.example/metadata.json';
    const fetchOne = jest
      .fn()
      .mockRejectedValueOnce(new Error('HTTP error: 503'))
      // the second host holds the connection for the whole budget before failing
      .mockImplementationOnce(async () => {
        now += METADATA_URI_BUDGET_MS;
        throw new Error('Request timed out after 30000ms of inactivity');
      })
      .mockResolvedValueOnce(METADATA);

    try {
      await expect(fetchMetadataFromUris([HTTPS_URI, IPFS_URI, THIRD_URI], 'ab', fetchOne)).rejects.toThrow(
        'HTTP error: 503',
      );
      expect(fetchOne).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // A gallery-wide pass starts every NFT's walk at once, and each first
  // attempt then waits in the cache's download queue — time no host consumed,
  // which must not use up the budget meant for the fallbacks.
  it('does not charge time the first attempt spent queued against the fallbacks', async () => {
    let now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchOne = jest
      .fn()
      .mockImplementationOnce(async () => {
        now += 10 * METADATA_URI_BUDGET_MS; // queued for a long while, then the host fails fast
        throw new Error('HTTP error: 403');
      })
      .mockResolvedValueOnce(METADATA);

    try {
      await expect(fetchMetadataFromUris([HTTPS_URI, IPFS_URI], 'ab', fetchOne)).resolves.toEqual(METADATA);
      expect(fetchOne).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps falling through while the budget lasts', async () => {
    let now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchOne = jest
      .fn()
      .mockRejectedValueOnce(new Error('HTTP error: 504'))
      .mockImplementationOnce(async () => {
        now += METADATA_URI_BUDGET_MS / 2;
        throw new Error('HTTP error: 504');
      })
      .mockResolvedValueOnce(METADATA);

    try {
      await expect(
        fetchMetadataFromUris([HTTPS_URI, IPFS_URI, 'https://mirror.example/metadata.json'], 'ab', fetchOne),
      ).resolves.toEqual(METADATA);
      expect(fetchOne).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // Without a hash no copy can be told from another, so a second host adds a
  // fetch without adding confidence — the first URI serves as it always has.
  it('tries only the first URI of an NFT that records no metadata hash', async () => {
    const fetchOne = jest.fn().mockRejectedValue(new Error('HTTP error: 503'));

    await expect(fetchMetadataFromUris([HTTPS_URI, IPFS_URI], undefined, fetchOne)).rejects.toThrow('HTTP error: 503');
    await expect(fetchMetadataFromUris([HTTPS_URI, IPFS_URI], '', fetchOne)).rejects.toThrow('HTTP error: 503');
    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(fetchOne).toHaveBeenNthCalledWith(1, HTTPS_URI, undefined);
    expect(fetchOne).toHaveBeenNthCalledWith(2, HTTPS_URI, '');
  });

  it('returns the metadata served by the first URI without touching the others', async () => {
    const fetchOne = jest.fn().mockResolvedValue(METADATA);

    await expect(fetchMetadataFromUris([HTTPS_URI, IPFS_URI], 'ab', fetchOne)).resolves.toEqual(METADATA);
    expect(fetchOne).toHaveBeenCalledTimes(1);
    expect(fetchOne).toHaveBeenCalledWith(HTTPS_URI, 'ab');
  });

  it('falls through to the next URI when a host fails', async () => {
    const fetchOne = jest.fn().mockRejectedValueOnce(new Error('HTTP error: 403')).mockResolvedValueOnce(METADATA);

    await expect(fetchMetadataFromUris([HTTPS_URI, IPFS_URI], 'ab', fetchOne)).resolves.toEqual(METADATA);
    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(fetchOne).toHaveBeenLastCalledWith(IPFS_URI, 'ab');
  });

  it('reports the first failure when every URI fails', async () => {
    const fetchOne = jest
      .fn()
      .mockRejectedValueOnce(new Error('HTTP error: 504'))
      .mockRejectedValueOnce(new Error('IPFS gateway fetching is disabled'));

    await expect(fetchMetadataFromUris([HTTPS_URI, IPFS_URI], 'ab', fetchOne)).rejects.toThrow('HTTP error: 504');
    expect(fetchOne).toHaveBeenCalledTimes(2);
  });

  it('reports a checksum mismatch over a download failure', async () => {
    const fetchOne = jest
      .fn()
      .mockRejectedValueOnce(new Error('HTTP error: 504'))
      .mockRejectedValueOnce(new Error(CHECKSUM_MISMATCH_ERROR));

    await expect(fetchMetadataFromUris([HTTPS_URI, IPFS_URI], 'ab', fetchOne)).rejects.toThrow(CHECKSUM_MISMATCH_ERROR);
  });

  it('keeps trying after a checksum mismatch in case another copy matches', async () => {
    const fetchOne = jest
      .fn()
      .mockRejectedValueOnce(new Error(CHECKSUM_MISMATCH_ERROR))
      .mockResolvedValueOnce(METADATA);

    await expect(fetchMetadataFromUris([HTTPS_URI, IPFS_URI], 'ab', fetchOne)).resolves.toEqual(METADATA);
  });

  it('rejects an NFT without metadata URIs before fetching anything', async () => {
    const fetchOne = jest.fn();

    await expect(fetchMetadataFromUris([], 'ab', fetchOne)).rejects.toThrow('No metadata URI');
    await expect(fetchMetadataFromUris(undefined, 'ab', fetchOne)).rejects.toThrow('No metadata URI');
    expect(fetchOne).not.toHaveBeenCalled();
  });
});
