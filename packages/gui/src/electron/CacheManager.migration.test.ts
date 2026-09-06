import { dialog } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type DownloadFile = typeof import('./utils/downloadFile').default;
const mockDownloadFile = jest.fn<ReturnType<DownloadFile>, Parameters<DownloadFile>>();
jest.mock('electron', () => ({ BrowserWindow: jest.fn(), dialog: { showOpenDialog: jest.fn() } }));
jest.mock('./utils/downloadFile', () => ({
  ...jest.requireActual('./utils/downloadFile'),
  default: mockDownloadFile,
}));
jest.mock('./utils/ipcMainHandle', () => ({ __esModule: true, default: jest.fn() }));

const CacheManager = jest.requireActual<typeof import('./CacheManager')>('./CacheManager').default;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Use real temporary directories; only Electron's picker and the transfer
// itself are mocked. Explicit barriers exercise the race, without sleeps.
describe('CacheManager directory migration', () => {
  let root: string;
  let oldDirectory: string;
  let newDirectory: string;

  beforeEach(async () => {
    mockDownloadFile.mockReset();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'chia-cache-migration-'));
    oldDirectory = path.join(root, 'old');
    newDirectory = path.join(root, 'new');
    (dialog.showOpenDialog as jest.Mock).mockResolvedValue({ canceled: false, filePaths: [newDirectory] });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('drains abort cleanup and holds a replacement request outside the drained map', async () => {
    const started = deferred();
    const aborted = deferred();
    const finish = deferred();
    mockDownloadFile
      .mockImplementationOnce(async (_url, file, options) => {
        await fs.writeFile(`${file}.tmp`, 'partial');
        started.resolve();
        await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        aborted.resolve();
        await finish.promise;
        await fs.unlink(`${file}.tmp`);
        throw new Error('Request aborted');
      })
      .mockImplementationOnce(async (_url, file) => {
        await fs.writeFile(file, 'complete');
        return { 'content-type': 'image/png' };
      });
    const cache = new CacheManager({ cacheDirectory: oldDirectory });
    await cache.init();
    const first = cache.getContent('https://example.com/one').catch((error: Error) => error);
    await started.promise;
    const migration = cache.setCacheDirectory();
    await aborted.promise;
    const replacement = cache.getContent('https://example.com/one');
    expect(cache.cacheDirectory).toBe(oldDirectory);
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    finish.resolve();
    await migration;
    expect(await first).toBeInstanceOf(Error);
    expect((await replacement).toString()).toBe('complete');
    expect(cache.cacheDirectory).toBe(newDirectory);
    expect(await fs.readdir(oldDirectory)).toEqual([]);
    await cache.clearCache();
    expect(await fs.readdir(newDirectory)).toEqual([]);
  });

  it('moves completed bytes and their sidecar together even when success has passed abort', async () => {
    const started = deferred();
    const aborted = deferred();
    const finish = deferred();
    mockDownloadFile.mockImplementation(async (_url, file, options) => {
      await fs.writeFile(`${file}.tmp`, 'complete');
      options?.signal?.addEventListener('abort', aborted.resolve, { once: true });
      started.resolve();
      await finish.promise;
      await fs.rename(`${file}.tmp`, file);
      return { 'content-type': 'image/png' };
    });
    const cache = new CacheManager({ cacheDirectory: oldDirectory });
    await cache.init();
    const content = cache.getContent('https://example.com/two');
    await started.promise;
    const migration = cache.setCacheDirectory();
    await aborted.promise;
    finish.resolve();
    await migration;
    expect((await content).toString()).toBe('complete');
    expect(await fs.readdir(oldDirectory)).toEqual([]);
    const files = await fs.readdir(newDirectory);
    expect(files).toHaveLength(2);
    const infoFile = files.find((file) => file.endsWith('-info'))!;
    expect(JSON.parse(await fs.readFile(path.join(newDirectory, infoFile), 'utf-8')).state).toBe('CACHED');
    await cache.clearCache();
    expect(await fs.readdir(newDirectory)).toEqual([]);
  });

  it('executes a clear queued behind a migration against the completed destination', async () => {
    mockDownloadFile.mockImplementation(async (_url, file) => {
      await fs.writeFile(file, 'complete');
      return {};
    });
    const cache = new CacheManager({ cacheDirectory: oldDirectory });
    await cache.init();
    await cache.getContent('https://example.com/three');
    const migration = cache.setCacheDirectory();
    // Allow the already-resolved picker to enqueue migration first.
    await Promise.resolve();
    await Promise.resolve();
    const clear = cache.clearCache();
    await Promise.all([migration, clear]);
    expect(cache.cacheDirectory).toBe(newDirectory);
    expect(await fs.readdir(oldDirectory)).toEqual([]);
    expect(await fs.readdir(newDirectory)).toEqual([]);
  });

  it('rolls back copied files on failure without clobbering a destination or poisoning admission', async () => {
    mockDownloadFile.mockImplementation(async (_url, file) => {
      await fs.writeFile(file, 'complete');
      return {};
    });
    const cache = new CacheManager({ cacheDirectory: oldDirectory });
    await cache.init();
    await cache.getContent('https://example.com/four');
    const files = await fs.readdir(oldDirectory);
    await fs.mkdir(newDirectory);
    await fs.writeFile(path.join(newDirectory, files[1]), 'existing');
    await expect(cache.setCacheDirectory()).rejects.toThrow('EEXIST');
    expect(cache.cacheDirectory).toBe(oldDirectory);
    expect((await cache.getContent('https://example.com/four')).toString()).toBe('complete');
    expect(await fs.readFile(path.join(newDirectory, files[1]), 'utf-8')).toBe('existing');
    expect(await fs.readdir(newDirectory)).toHaveLength(1);
    expect(await fs.readdir(oldDirectory)).toHaveLength(2);
  });
});
