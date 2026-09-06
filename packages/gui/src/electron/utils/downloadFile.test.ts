import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mockNetRequest = jest.fn();

jest.mock('electron', () => ({
  net: {
    request: mockNetRequest,
  },
}));

const downloadFile = jest.requireActual<typeof import('./downloadFile')>('./downloadFile').default;

describe('downloadFile', () => {
  beforeEach(() => {
    mockNetRequest.mockReset();
  });

  it('still settles when its temp file was removed from under it', async () => {
    const localPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'downloadFile-test-')), 'nft.png');
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    const request = Object.assign(new EventEmitter(), {
      abort: jest.fn(),
      setHeader: jest.fn(),
      end: jest.fn(() => request.emit('response', response)),
    });
    mockNetRequest.mockReturnValue(request);

    const pending = downloadFile('https://example.com/nft.png', localPath);
    // let the write stream open (and so create) the temp file, then take it
    // away the way "Clear cache" would, and abort the transfer
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    await fs.rm(`${localPath}.tmp`, { force: true });
    response.emit('aborted');

    await expect(pending).rejects.toThrow('Response aborted');
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
