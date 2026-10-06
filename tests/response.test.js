import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { makeHttpRequest } from '../dist/index.js';
import { encode, mockFetch, pendingBody, trackTimers } from './helpers.js';

const readers = ['jsonWithTimeout', 'textWithTimeout', 'arrayBufferWithTimeout', 'blobWithTimeout', 'bytesWithTimeout'];

test('five native conversions retain values and clear successful-read timers', async t => {
    const timers = trackTimers(t);
    mockFetch(t, async () => new Response('{"value":7}', { headers: { 'Content-Type': 'application/json' } }));
    for (const method of readers) {
        const response = await makeHttpRequest('https://example.test');
        const value = await response[method](1000);
        if (method === 'jsonWithTimeout') assert.deepEqual(value, { value: 7 });
        if (method === 'textWithTimeout') assert.equal(value, '{"value":7}');
        if (method === 'arrayBufferWithTimeout') assert.equal(new TextDecoder().decode(value), '{"value":7}');
        if (method === 'blobWithTimeout') {
            assert.equal(await value.text(), '{"value":7}');
            assert.equal(value.type, 'application/json');
        }
        if (method === 'bytesWithTimeout') assert.deepEqual(value, encode('{"value":7}'));
        assert.equal(response.bodyUsed, true);
        assert.equal(timers.size, 0);
        await assert.rejects(response.text(), TypeError);
    }
});

test('invalid read deadlines do not consume the body; zero adds no timer', async t => {
    const timers = trackTimers(t);
    mockFetch(t, async () => new Response('{"ok":true}'));
    for (const method of readers) {
        const response = await makeHttpRequest('https://example.test');
        for (const ms of [-1, 0.5, NaN, Infinity, 2147483648, null, '10']) {
            await assert.rejects(response[method](ms));
            assert.equal(response.bodyUsed, false);
            assert.equal(response.body.locked, false);
        }
        await response[method](0);
        assert.equal(timers.size, 0);
    }
});

test('all timed readers cancel unfinished bodies and release locks on timeout', async t => {
    const timers = trackTimers(t);
    for (const method of readers) {
        const body = pendingBody();
        mockFetch(t, async () => new Response(body.stream));
        const response = await makeHttpRequest('https://example.test');
        await assert.rejects(response[method](10), { name: 'TimeoutError' });
        assert.equal(body.cancellations.length, 1);
        assert.equal(response.body.locked, false);
        assert.equal(timers.size, 0);
    }
});

test('parse and stream errors propagate without retained timers', async t => {
    const timers = trackTimers(t);
    const fetch = mockFetch(t, async () => new Response('invalid JSON'));
    const response = await makeHttpRequest('https://example.test');
    await assert.rejects(response.jsonWithTimeout(1000), SyntaxError);
    const failure = new Error('stream failed');
    fetch.mock.mockImplementation(async () => new Response(new ReadableStream({ start(c) { c.error(failure); } })));
    const broken = await makeHttpRequest('https://example.test');
    await assert.rejects(broken.textWithTimeout(1000), error => error === failure);
    assert.equal(timers.size, 0);
});

test('metadata, clone, ordinary properties and reflection remain coherent', async t => {
    mockFetch(t, async () => {
        const raw = new Response('content', { status: 201, statusText: 'Created', headers: { 'X-Test': 'one' } });
        Object.defineProperties(raw, { url: { value: 'https://example.test/final' }, redirected: { value: true } });
        return raw;
    });
    const response = await makeHttpRequest('https://example.test');
    assert.equal(response.status, 201);
    assert.equal(response.url, 'https://example.test/final');
    assert.equal(response.redirected, true);
    assert.equal('status' in response, true);
    response.requestId = 'local';
    assert.equal(response.requestId, 'local');
    Object.defineProperty(response, 'fixed', { value: 'metadata', configurable: false });
    assert.equal(response.fixed, 'metadata');
    assert.equal(response.text, response.text);
    const clone = response.clone();
    clone.headers.set('X-Test', 'two');
    assert.equal(response.headers.get('X-Test'), 'one');
    assert.equal(clone.status, 201);
    assert.equal(clone.url, response.url);
    assert.equal(typeof clone.textWithTimeout, 'function');
    assert.equal(await response.text(), 'content');
    assert.equal(await clone.textWithTimeout(), 'content');
    assert.throws(() => response.clone(), TypeError);
});

test('a timed-out clone branch does not abort a sibling still in use', async t => {
    const body = pendingBody();
    mockFetch(t, async () => new Response(body.stream));
    const response = await makeHttpRequest('https://example.test');
    const clone = response.clone();
    await assert.rejects(response.textWithTimeout(10), { name: 'TimeoutError' });
    assert.equal(body.cancellations.length, 0);
    body.controller.enqueue(encode('sibling survives'));
    body.controller.close();
    assert.equal(await clone.textWithTimeout(1000), 'sibling survives');
});

test('cancelling every clone branch cancels the underlying source', async t => {
    const body = pendingBody();
    mockFetch(t, async () => new Response(body.stream));
    const response = await makeHttpRequest('https://example.test');
    const clone = response.clone();
    await Promise.all([
        assert.rejects(response.textWithTimeout(10), { name: 'TimeoutError' }),
        assert.rejects(clone.textWithTimeout(10), { name: 'TimeoutError' }),
    ]);
    await delay(0);
    assert.equal(body.cancellations.length, 1);
});

test('external abort remains effective after response headers', async t => {
    const body = pendingBody();
    mockFetch(t, async () => new Response(body.stream));
    const controller = new AbortController();
    const response = await makeHttpRequest('https://example.test', 'GET', null, null, null, 0, controller.signal);
    const reason = new Error('stop body');
    const pending = response.textWithTimeout(0);
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(body.cancellations.length, 1);
});

test('missing native bytes affects only bytes calls, without a fallback', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(Response.prototype, 'bytes');
    Object.defineProperty(Response.prototype, 'bytes', { ...descriptor, value: undefined });
    t.after(() => Object.defineProperty(Response.prototype, 'bytes', descriptor));
    mockFetch(t, async () => new Response('ok'));
    const response = await makeHttpRequest('https://example.test');
    await assert.rejects(response.bytesWithTimeout(), TypeError);
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.textWithTimeout(), 'ok');
});

test('external abort listeners are released after manual body reading or cancellation', async t => {
    for (const cancel of [false, true]) {
        const controller = new AbortController();
        const listeners = new Set();
        const add = controller.signal.addEventListener.bind(controller.signal);
        const remove = controller.signal.removeEventListener.bind(controller.signal);
        t.mock.method(controller.signal, 'addEventListener', (type, listener, options) => {
            if (type === 'abort') listeners.add(listener);
            add(type, listener, options);
        });
        t.mock.method(controller.signal, 'removeEventListener', (type, listener, options) => {
            if (type === 'abort') listeners.delete(listener);
            remove(type, listener, options);
        });
        mockFetch(t, async () => new Response('content'));
        const response = await makeHttpRequest('https://example.test', 'GET', null, null, null, 0, controller.signal);
        assert.equal(listeners.size, 1);
        if (cancel) {
            await response.body.cancel();
        } else {
            const reader = response.body.getReader();
            while (!(await reader.read()).done) {}
            reader.releaseLock();
        }
        assert.equal(listeners.size, 0);
    }
});
