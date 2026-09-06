import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type DownloadFile = typeof import('./utils/downloadFile').default;

const mockDownloadFile = jest.fn<ReturnType<DownloadFile>, Parameters<DownloadFile>>();

jest.mock('electron', () => ({
  BrowserWindow: jest.fn(),
  dialog: {
    showOpenDialog: jest.fn(),
  },
}));

jest.mock('./utils/downloadFile', () => ({
  __esModule: true,
  default: mockDownloadFile,
  MAX_FILE_SIZE_EXCEEDED_ERROR: 'Maximum file size exceeded',
  TEMP_FILE_SUFFIX: '.tmp',
  isDownloadTimeoutError: jest.requireActual('./utils/downloadFile').isDownloadTimeoutError,
}));

jest.mock('./utils/ipcMainHandle', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const CacheManager = jest.requireActual<typeof import('./CacheManager')>('./CacheManager').default;

// The download starts only after the sidecar has been read, so a test that
// interferes with an in-flight download has to wait for it to actually start.
async function untilDownloadsStarted(count: number) {
  for (let attempt = 0; attempt < 200 && mockDownloadFile.mock.calls.length < count; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  expect(mockDownloadFile).toHaveBeenCalledTimes(count);
}

describe('CacheManager eviction', () => {
  let cacheDirectory: string;

  beforeEach(async () => {
    mockDownloadFile.mockReset();
    cacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'chia-cache-manager-'));
  });

  afterEach(async () => {
    await fs.rm(cacheDirectory, { recursive: true, force: true });
  });

  it('does not evict a just-downloaded file that fits within the configured total size', async () => {
    const payload = Buffer.alloc(600, 7);
    mockDownloadFile.mockImplementation(async (_url, localPath) => {
      await fs.writeFile(localPath, payload);
      return {
        'content-type': 'image/png',
      };
    });

    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    await expect(cacheManager.getContent('https://example.com/nft.png')).resolves.toEqual(payload);
    await expect(cacheManager.getCacheSize()).resolves.toBeLessThanOrEqual(1024);
  });

  it('keeps a completed download cached when cache housekeeping fails', async () => {
    const payload = Buffer.from('cached payload');
    mockDownloadFile.mockImplementation(async (_url, localPath) => {
      await fs.writeFile(localPath, payload);
      return {
        'content-type': 'image/png',
      };
    });

    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    // A concurrent invalidation can delete files mid-scan and make the
    // post-download size check fail — that must not poison the download.
    jest
      .spyOn(cacheManager, 'getCacheSize')
      .mockRejectedValueOnce(new Error("ENOENT: no such file or directory, stat '/cache/other-chiacache'"));

    await expect(cacheManager.getContent('https://example.com/nft.png')).resolves.toEqual(payload);
    await expect(cacheManager.getContent('https://example.com/nft.png')).resolves.toEqual(payload);
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
  });

  it('ignores files that vanish while the cache size is being measured', async () => {
    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    await fs.writeFile(path.join(cacheDirectory, 'aaaa-chiacache'), Buffer.alloc(100));
    // a broken symlink stats like a file deleted between readdir and stat
    await fs.symlink(path.join(cacheDirectory, 'missing-target'), path.join(cacheDirectory, 'bbbb-chiacache'));

    await expect(cacheManager.getCacheSize()).resolves.toBe(100);
  });

  it('evicts without failing when a file vanishes during the eviction scan', async () => {
    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    await fs.writeFile(path.join(cacheDirectory, 'aaaa-chiacache'), Buffer.alloc(200));
    await fs.symlink(path.join(cacheDirectory, 'missing-target'), path.join(cacheDirectory, 'bbbb-chiacache'));

    await expect(cacheManager.setMaxCacheSize(100)).resolves.toBeUndefined();
    await expect(fs.stat(path.join(cacheDirectory, 'aaaa-chiacache'))).rejects.toThrow('ENOENT');
  });

  it('does not retry a timed-out download on the next access', async () => {
    mockDownloadFile.mockRejectedValue(new Error('Request timed out after 30000ms of inactivity'));

    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    await expect(cacheManager.getContent('https://example.com/nft.png')).rejects.toThrow('Request timed out');
    await expect(cacheManager.getContent('https://example.com/nft.png')).rejects.toThrow('Request timed out');
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
  });

  it('retries a timeout persisted by a previous session', async () => {
    const payload = Buffer.from('cached payload');
    mockDownloadFile.mockRejectedValue(new Error('Request timed out after 30000ms of inactivity'));

    const firstSession = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await firstSession.init();
    await expect(firstSession.getContent('https://example.com/nft.png')).rejects.toThrow('Request timed out');

    mockDownloadFile.mockReset();
    mockDownloadFile.mockImplementation(async (_url, localPath) => {
      await fs.writeFile(localPath, payload);
      return {
        'content-type': 'image/png',
      };
    });

    const secondSession = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await secondSession.init();
    await expect(secondSession.getContent('https://example.com/nft.png')).resolves.toEqual(payload);
  });

  it('retries an aborted download on the next access', async () => {
    const payload = Buffer.from('cached payload');
    mockDownloadFile.mockRejectedValueOnce(new Error('Request aborted')).mockImplementation(async (_url, localPath) => {
      await fs.writeFile(localPath, payload);
      return {
        'content-type': 'image/png',
      };
    });

    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    await expect(cacheManager.getContent('https://example.com/nft.png')).rejects.toThrow('Request aborted');
    await expect(cacheManager.getContent('https://example.com/nft.png')).resolves.toEqual(payload);
    expect(mockDownloadFile).toHaveBeenCalledTimes(2);
  });

  it('does not overlap cache size scans when a scan outlives the coalescing window', async () => {
    jest.useFakeTimers();
    try {
      const cacheManager = new CacheManager({
        cacheDirectory,
        maxCacheSize: 1024,
      });
      await cacheManager.init();

      let runningScans = 0;
      let maxConcurrentScans = 0;
      const scanResolvers: Array<() => void> = [];
      const getCacheSizeSpy = jest.spyOn(cacheManager, 'getCacheSize').mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            runningScans += 1;
            maxConcurrentScans = Math.max(maxConcurrentScans, runningScans);
            scanResolvers.push(() => {
              runningScans -= 1;
              resolve(0);
            });
          }),
      );

      const send = jest.fn();
      const fakeWindow = {
        webContents: { send },
        isDestroyed: () => false,
        on: jest.fn(),
      } as any;
      cacheManager.bindEvents(fakeWindow);

      cacheManager.emit('sizeChanged');
      jest.advanceTimersByTime(500); // the first scan starts and stays in flight

      cacheManager.emit('sizeChanged'); // burst arriving mid-scan
      jest.advanceTimersByTime(500); // previously this started an overlapping scan

      expect(maxConcurrentScans).toBe(1);

      scanResolvers.shift()?.();
      await Promise.resolve(); // let the first scan settle and reschedule
      jest.advanceTimersByTime(500); // the follow-up scan delivers the fresh size

      expect(getCacheSizeSpy).toHaveBeenCalledTimes(2);
      expect(maxConcurrentScans).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // Both eviction gates are `> 0`, so a zero limit would not mean "no cache"
  // but "no eviction" — the renderer-reachable state SEC-866 was about.
  it.each([0, '0', '', -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %p as a cache limit and keeps the current one',
    async (limit) => {
      const cacheManager = new CacheManager({
        cacheDirectory,
        maxCacheSize: 1024,
      });
      await cacheManager.init();

      await expect(cacheManager.setMaxCacheSize(limit)).rejects.toThrow('positive finite number');
      expect(cacheManager.maxCacheSize).toBe(1024);
    },
  );

  // Downloads stream into `<file>.tmp` and rename into place; a quit or crash
  // mid-download leaves the temp file behind. Those files are the cache's too.
  it('sweeps leftover temp files at startup', async () => {
    const stale = path.join(cacheDirectory, 'aaaa-chiacache.tmp');
    await fs.writeFile(stale, Buffer.alloc(300));
    await fs.writeFile(path.join(cacheDirectory, 'bbbb-chiacache'), Buffer.alloc(100));
    await fs.writeFile(path.join(cacheDirectory, 'unrelated.tmp'), Buffer.alloc(50));

    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    await expect(fs.stat(stale)).rejects.toThrow('ENOENT');
    // cached files, and files that are not the cache's, are left alone
    await expect(fs.stat(path.join(cacheDirectory, 'bbbb-chiacache'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(cacheDirectory, 'unrelated.tmp'))).resolves.toBeDefined();
  });

  it('counts temp files toward the cache size and removes them with the cache', async () => {
    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    const temp = path.join(cacheDirectory, 'aaaa-chiacache.tmp');
    await fs.writeFile(temp, Buffer.alloc(300));
    await fs.writeFile(path.join(cacheDirectory, 'bbbb-chiacache'), Buffer.alloc(100));

    await expect(cacheManager.getCacheSize()).resolves.toBe(400);

    await cacheManager.clearCache();
    await expect(fs.stat(temp)).rejects.toThrow('ENOENT');
    await expect(cacheManager.getCacheSize()).resolves.toBe(0);
  });

  it('leaves the temp file of a download in flight to that download when clearing the cache', async () => {
    const inFlightUrl = 'https://example.com/in-flight.png';
    let tempFilePath = '';
    let cleanedUpByDownload = false;
    mockDownloadFile.mockImplementation(async (_url, localPath, options) => {
      // the real downloadFile streams into the temp file, and on abort removes
      // it itself — which must still find it there
      tempFilePath = `${localPath}.tmp`;
      await fs.writeFile(tempFilePath, Buffer.alloc(300));
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve());
      });
      await fs.unlink(tempFilePath);
      cleanedUpByDownload = true;
      throw new Error('Request aborted');
    });

    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    const pending = cacheManager.getContent(inFlightUrl);
    await untilDownloadsStarted(1);
    await fs.writeFile(path.join(cacheDirectory, 'bbbb-chiacache'), Buffer.alloc(100));

    await cacheManager.clearCache();

    await expect(pending).rejects.toThrow('Request aborted');
    expect(cleanedUpByDownload).toBe(true);
    await expect(fs.stat(tempFilePath)).rejects.toThrow('ENOENT');
    await expect(fs.stat(path.join(cacheDirectory, 'bbbb-chiacache'))).rejects.toThrow('ENOENT');
  });

  it('evicts a stale temp file but never the one a download in flight is writing', async () => {
    let finishDownload!: () => void;
    const inFlightUrl = 'https://example.com/in-flight.png';
    mockDownloadFile.mockImplementation(async (_url, localPath) => {
      // the real downloadFile streams into the temp file before renaming it
      await fs.writeFile(`${localPath}.tmp`, Buffer.alloc(300));
      await new Promise<void>((resolve) => {
        finishDownload = resolve;
      });
      await fs.rename(`${localPath}.tmp`, localPath);
      return {
        'content-type': 'image/png',
      };
    });

    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    const stale = path.join(cacheDirectory, 'aaaa-chiacache.tmp');
    await fs.writeFile(stale, Buffer.alloc(300));

    const pending = cacheManager.getContent(inFlightUrl);
    await untilDownloadsStarted(1);
    const inFlightTemp = (await fs.readdir(cacheDirectory)).find(
      (file) => file.endsWith('.tmp') && file !== 'aaaa-chiacache.tmp',
    );
    expect(inFlightTemp).toBeDefined();

    // both temp files count; evicting down to 350 bytes must drop the stale
    // one and keep the live one
    await expect(cacheManager.getCacheSize()).resolves.toBe(600);
    await cacheManager.setMaxCacheSize(350);
    await expect(fs.stat(stale)).rejects.toThrow('ENOENT');
    await expect(fs.stat(path.join(cacheDirectory, inFlightTemp!))).resolves.toBeDefined();

    finishDownload();
    await expect(pending).resolves.toEqual(Buffer.alloc(300));
  });

  it('reports a sidecar that cannot be read by its error code, not its path', async () => {
    const url = 'https://example.com/nft.png';
    const urlHash = crypto.createHash('md5').update(url).digest('hex');
    // a directory where the sidecar should be makes readFile fail with EISDIR
    await fs.mkdir(path.join(cacheDirectory, `${urlHash}-chiacache-info`));

    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    const [info] = await cacheManager.getCacheInfos([url]);
    expect(info).toMatchObject({ state: 'ERROR', error: 'EISDIR' });
    expect(info.state === 'ERROR' && info.error.includes(cacheDirectory)).toBe(false);
  });
});

describe('CacheManager getCacheInfos', () => {
  let cacheDirectory: string;

  beforeEach(async () => {
    mockDownloadFile.mockReset();
    cacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'chia-cache-manager-'));
  });

  afterEach(async () => {
    await fs.rm(cacheDirectory, { recursive: true, force: true });
  });

  it('reports persisted outcomes per url without downloading anything', async () => {
    const payload = Buffer.from('cached payload');
    mockDownloadFile.mockImplementation(async (url, localPath) => {
      if (url === 'https://example.com/broken.png') {
        throw new Error('getaddrinfo ENOTFOUND example.com');
      }
      await fs.writeFile(localPath, payload);
      return {
        'content-type': 'image/png',
      };
    });

    const cacheManager = new CacheManager({
      cacheDirectory,
      maxCacheSize: 1024,
    });
    await cacheManager.init();

    await expect(cacheManager.getContent('https://example.com/ok.png')).resolves.toEqual(payload);
    await expect(cacheManager.getContent('https://example.com/broken.png')).rejects.toThrow('ENOTFOUND');
    mockDownloadFile.mockClear();

    const infos = await cacheManager.getCacheInfos([
      'https://example.com/ok.png',
      'https://example.com/broken.png',
      'https://example.com/never-requested.png',
      'not a url',
    ]);

    expect(infos.map((info) => [info.url, info.state])).toEqual([
      ['https://example.com/ok.png', 'CACHED'],
      ['https://example.com/broken.png', 'ERROR'],
      ['https://example.com/never-requested.png', 'NOT_CACHED'],
      ['not a url', 'ERROR'],
    ]);
    expect(infos[0]).toMatchObject({ checksum: expect.any(String) });
    expect(infos[1]).toMatchObject({ error: 'getaddrinfo ENOTFOUND example.com' });
    expect(infos[3]).toMatchObject({ error: 'Invalid URL: not a url' });
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });
});
