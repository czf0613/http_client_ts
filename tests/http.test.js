import assert from 'node:assert/strict';
import test from 'node:test';
import { joinUrlWithParams, makeHttpRequest } from '../dist/index.js';
import { mockFetch, trackTimers } from './helpers.js';

test('query parameters merge, replace matching keys, and precede fragments', () => {
    assert.equal(joinUrlWithParams('/items?old=1&old=2&keep=yes#details', { old: 3, q: 'hello world', enabled: true }),
        '/items?old=3&keep=yes&q=hello+world&enabled=true#details');
    assert.equal(joinUrlWithParams('https://example.test/path#part', { q: '中文' }),
        'https://example.test/path?q=%E4%B8%AD%E6%96%87#part');
    assert.equal(joinUrlWithParams('/path?x=1#part', {}), '/path?x=1#part');
    assert.throws(() => joinUrlWithParams('/path', { q: null }), TypeError);
});

test('PATCH, boolean queries, and case-insensitive immutable headers', async t => {
    let request;
    mockFetch(t, async (url, init) => {
        request = new Request(url, init);
        return new Response('ok');
    });
    const headers = Object.freeze({ 'content-type': 'application/problem+json', 'X-Request': 'one' });
    const response = await makeHttpRequest('https://example.test/items?old=1', 'PATCH', { enabled: true }, headers, { value: 1 });
    assert.equal(request.method, 'PATCH');
    assert.equal(request.url, 'https://example.test/items?old=1&enabled=true');
    assert.equal(request.headers.get('content-type'), 'application/problem+json');
    assert.deepEqual(await request.json(), { value: 1 });
    assert.deepEqual(headers, { 'content-type': 'application/problem+json', 'X-Request': 'one' });
    await response.text();
});

test('text, numbers, JSON and native request bodies reach Fetch without corruption', async t => {
    let request;
    mockFetch(t, async (url, init) => { request = new Request(url, init); return new Response(null); });
    for (const [body, expected, contentType] of [
        ['hello', 'hello', 'text/plain'],
        [42, '42', 'text/plain'],
        [{ value: 1 }, '{"value":1}', 'application/json'],
        [[1, 2], '[1,2]', 'application/json'],
        [new Blob(['file'], { type: 'application/octet-stream' }), 'file', 'application/octet-stream'],
        [new URLSearchParams({ q: 'hello world' }), 'q=hello+world', 'application/x-www-form-urlencoded;charset=UTF-8'],
        [new Uint8Array([65, 66]), 'AB', null],
        [new Uint8Array([65, 66]).buffer, 'AB', null],
        [new DataView(new Uint8Array([65, 66]).buffer), 'AB', null],
    ]) {
        await makeHttpRequest('https://example.test', 'POST', null, null, body);
        assert.equal(await request.text(), expected);
        assert.equal(request.headers.get('content-type'), contentType);
    }
    await assert.rejects(makeHttpRequest('https://example.test', 'POST', null, null, new ReadableStream()), TypeError);
});

test('FormData removes any Content-Type spelling and leaves the input untouched', async t => {
    let request;
    mockFetch(t, async (url, init) => { request = new Request(url, init); return new Response(null); });
    const form = new FormData();
    form.append('name', 'Ada');
    const headers = Object.freeze({ 'CONTENT-TYPE': 'multipart/form-data' });
    await makeHttpRequest('https://example.test', 'POST', null, headers, form);
    assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/);
    assert.equal((await request.formData()).get('name'), 'Ada');
    assert.equal(headers['CONTENT-TYPE'], 'multipart/form-data');
});

test('plain HTTP error responses remain inspectable', async t => {
    mockFetch(t, async () => new Response('not found', { status: 404 }));
    const response = await makeHttpRequest('https://example.test');
    assert.equal(response.ok, false);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'not found');
});

test('request timers are cleared on success, rejection and timeout', async t => {
    const timers = trackTimers(t);
    const fetch = mockFetch(t, async () => new Response(null));
    await makeHttpRequest('https://example.test');
    assert.equal(timers.size, 0);
    const failure = new Error('network failed');
    fetch.mock.mockImplementation(async () => { throw failure; });
    await assert.rejects(makeHttpRequest('https://example.test'), error => error === failure);
    assert.equal(timers.size, 0);
    let signal;
    fetch.mock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        signal = init.signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await assert.rejects(makeHttpRequest('https://example.test', 'GET', null, null, null, 10), { name: 'TimeoutError' });
    assert.equal(signal.aborted, true);
    assert.equal(timers.size, 0);
});

test('invalid request timeouts fail before Fetch; zero disables the timer', async t => {
    const timers = trackTimers(t);
    const fetch = mockFetch(t, async () => new Response(null));
    for (const ms of [-1, 0.5, NaN, Infinity, 2147483648, null, '10']) {
        await assert.rejects(makeHttpRequest('https://example.test', 'GET', null, null, null, ms));
    }
    assert.equal(fetch.mock.callCount(), 0);
    await makeHttpRequest('https://example.test', 'GET', null, null, null, 0);
    assert.equal(timers.size, 0);
});

test('pre-aborted and pending header requests preserve the external abort reason', async t => {
    const fetch = mockFetch(t, (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    const controller = new AbortController();
    const reason = new Error('cancelled by caller');
    controller.abort(reason);
    await assert.rejects(makeHttpRequest('https://example.test', 'GET', null, null, null, 0, controller.signal), error => error === reason);
    assert.equal(fetch.mock.callCount(), 0);
    const pendingController = new AbortController();
    const pending = makeHttpRequest('https://example.test', 'GET', null, null, null, 0, pendingController.signal);
    pendingController.abort(reason);
    await assert.rejects(pending, error => error === reason);
});

test('abort during body serialization still prevents the request', async t => {
    const fetch = mockFetch(t, async () => new Response(null));
    const controller = new AbortController();
    const reason = new Error('cancel during preparation');
    const body = { toJSON() { controller.abort(reason); return { value: 1 }; } };
    await assert.rejects(makeHttpRequest('https://example.test', 'POST', null, null, body, 0, controller.signal), error => error === reason);
    assert.equal(fetch.mock.callCount(), 0);
});
