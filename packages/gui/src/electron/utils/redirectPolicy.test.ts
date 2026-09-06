import { EventEmitter } from 'node:events';

import guardRedirects, { MAX_REDIRECTS, isAllowedRedirect } from './redirectPolicy';

describe('isAllowedRedirect', () => {
  it.each([
    ['https://minter.example/a.png', 'https://cdn.example/a.png'],
    ['https://minter.example/a.png', 'https://ipfs.io/ipfs/QmPK1s3pNYLi9ERiq3BDxKa4XosgWwFRQUydHUtz4YgpqB'],
    // a local gateway may canonicalize a path within its own origin
    [
      'http://127.0.0.1:8080/ipfs/QmPK1s3pNYLi9ERiq3BDxKa4XosgWwFRQUydHUtz4YgpqB',
      'http://127.0.0.1:8080/ipfs/QmPK1s3pNYLi9ERiq3BDxKa4XosgWwFRQUydHUtz4YgpqB/',
    ],
    ['http://localhost:8080/ipfs/x', 'http://localhost:8080/ipfs/x/'],
  ])('allows %s -> %s', (from, to) => {
    expect(isAllowedRedirect(from, to)).toBe(true);
  });

  it.each([
    // scheme downgrade
    ['https://minter.example/a.png', 'http://minter.example/a.png'],
    // loopback and private hosts, whatever the scheme
    ['https://minter.example/a.png', 'http://127.0.0.1:8080/api/v0/shutdown'],
    ['https://minter.example/a.png', 'http://localhost:5000/'],
    ['https://minter.example/a.png', 'http://[::1]:8080/'],
    ['https://minter.example/a.png', 'http://192.168.1.1/'],
    ['https://minter.example/a.png', 'http://169.254.169.254/latest/meta-data/'],
    ['https://minter.example/a.png', 'http://10.0.0.1/'],
    // other schemes
    ['https://minter.example/a.png', 'file:///etc/passwd'],
    ['https://minter.example/a.png', 'data:text/html,hi'],
    ['https://minter.example/a.png', 'ipfs://QmPK1s3pNYLi9ERiq3BDxKa4XosgWwFRQUydHUtz4YgpqB'],
    // a local gateway may not send the request anywhere else
    ['http://127.0.0.1:8080/ipfs/x', 'http://127.0.0.1:9090/ipfs/x'],
    ['http://127.0.0.1:8080/ipfs/x', 'http://localhost:8080/ipfs/x'],
    ['http://127.0.0.1:8080/ipfs/x', 'http://192.168.1.1/ipfs/x'],
    // garbage
    ['https://minter.example/a.png', 'not a url'],
    ['https://minter.example/a.png', ''],
  ])('refuses %s -> %s', (from, to) => {
    expect(isAllowedRedirect(from, to)).toBe(false);
  });

  it('refuses a non-string target', () => {
    expect(isAllowedRedirect('https://minter.example/a.png', undefined as unknown as string)).toBe(false);
  });
});

describe('guardRedirects', () => {
  function makeRequest() {
    return Object.assign(new EventEmitter(), { followRedirect: jest.fn() });
  }

  it('follows allowed redirects and judges each hop from the previous target', () => {
    const request = makeRequest();
    const refuse = jest.fn();
    guardRedirects(request, 'https://minter.example/a.png', refuse);

    request.emit('redirect', 302, 'GET', 'https://cdn.example/a.png', {});
    expect(request.followRedirect).toHaveBeenCalledTimes(1);
    // the second hop downgrades: refused even though the first was fine
    request.emit('redirect', 302, 'GET', 'http://cdn.example/a.png', {});
    expect(request.followRedirect).toHaveBeenCalledTimes(1);
    expect(refuse).toHaveBeenCalledWith(expect.objectContaining({ message: 'Redirect refused' }));
  });

  it('stops after MAX_REDIRECTS hops', () => {
    const request = makeRequest();
    const refuse = jest.fn();
    guardRedirects(request, 'https://minter.example/a.png', refuse);

    for (let hop = 1; hop <= MAX_REDIRECTS; hop += 1) {
      request.emit('redirect', 302, 'GET', `https://hop${hop}.example/a.png`, {});
    }
    expect(request.followRedirect).toHaveBeenCalledTimes(MAX_REDIRECTS);
    expect(refuse).not.toHaveBeenCalled();

    request.emit('redirect', 302, 'GET', 'https://hop6.example/a.png', {});
    expect(request.followRedirect).toHaveBeenCalledTimes(MAX_REDIRECTS);
    expect(refuse).toHaveBeenCalledWith(expect.objectContaining({ message: 'Too many redirects' }));
  });
});
