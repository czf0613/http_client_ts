import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { makeSSERequest } from '../dist/index.js';
import { collect, encode, mockFetch, pendingBody, streamResponse, trackTimers } from './helpers.js';

test('standard SSE lines, BOM, comments, fields and fragmented UTF-8', async t => {
    const wire = '\uFEFF: heartbeat\r\nid: 1\r\nevent: delta\r\nretry: 1000\r\nunknown: ignored\r\ndata: 你好\r\ndata:世界\r\n\r\ndata\r\rdata:  keep space \n\ndata: [DONE]\n\n';
    const bytes = encode(wire);
    mockFetch(t, async () => streamResponse(Array.from(bytes, byte => Uint8Array.of(byte))));
    assert.deepEqual(await collect(makeSSERequest('https://example.test')), {
        messages: ['你好\n世界', '', ' keep space ', '[DONE]'], result: true,
    });
});

test('SSE output is invariant under every two-chunk split', async t => {
    const bytes = encode('\uFEFFdata: 你好\r\ndata: second\r\n\r\ndata:\n\n');
    let chunks;
    mockFetch(t, async () => streamResponse(chunks));
    for (let split = 0; split <= bytes.length; split++) {
        chunks = [bytes.slice(0, split), bytes.slice(split)];
        assert.deepEqual((await collect(makeSSERequest('https://example.test'))).messages, ['你好\nsecond', '']);
    }
});

test('SSE strips only the stream BOM and one optional protocol space', async t => {
    mockFetch(t, async () => streamResponse(['data:\uFEFFkeep\n\ndata:  spaced \n\ndata: \n\n']));
    assert.deepEqual((await collect(makeSSERequest('https://example.test'))).messages, ['\uFEFFkeep', ' spaced ', '']);
});

test('EOF discards incomplete events while complete events remain delivered', async t => {
    mockFetch(t, async () => streamResponse(['data: complete\n\ndata: unfinished\n']));
    assert.deepEqual(await collect(makeSSERequest('https://example.test')), { messages: ['complete'], result: true });
});

test('HTTP errors throw into for-await and cancel unused response bodies', async t => {
    const body = pendingBody();
    const logs = t.mock.method(console, 'error', () => {});
    mockFetch(t, async () => new Response(body.stream, { status: 503, statusText: 'Unavailable' }));
    await assert.rejects(async () => {
        for await (const message of makeSSERequest('https://example.test')) assert.fail(message);
    }, { name: 'HTTPError', status: 503 });
    assert.equal(body.cancellations.length, 1);
    assert.equal(logs.mock.callCount(), 0);
});

test('missing bodies and stream failures reject instead of returning false', async t => {
    const fetch = mockFetch(t, async () => new Response(null, { status: 204 }));
    await assert.rejects(collect(makeSSERequest('https://example.test')), /body/i);
    const failure = new Error('broken stream');
    fetch.mock.mockImplementation(async () => new Response(new ReadableStream({ start(c) { c.error(failure); } })));
    await assert.rejects(collect(makeSSERequest('https://example.test')), error => error === failure);
});

test('early break cancels the source and releases timers', async t => {
    const timers = trackTimers(t);
    const body = pendingBody();
    body.controller.enqueue(encode('data: first\n\ndata: second\n\n'));
    mockFetch(t, async () => new Response(body.stream));
    for await (const message of makeSSERequest('https://example.test')) {
        assert.equal(message, 'first');
        break;
    }
    assert.equal(body.cancellations.length, 1);
    assert.equal(timers.size, 0);
});

test('read timeout cancels a pending SSE stream and cleans timers', async t => {
    const timers = trackTimers(t);
    const body = pendingBody();
    mockFetch(t, async () => new Response(body.stream));
    await assert.rejects(collect(makeSSERequest('https://example.test', 'GET', null, null, null, 1000, 10)), { name: 'TimeoutError' });
    assert.equal(body.cancellations.length, 1);
    assert.equal(timers.size, 0);
});

test('zero disables per-read deadlines and external abort still interrupts next()', async t => {
    const timers = trackTimers(t);
    const body = pendingBody();
    mockFetch(t, async () => new Response(body.stream));
    const controller = new AbortController();
    const generator = makeSSERequest('https://example.test', 'GET', null, null, null, 0, 0, controller.signal);
    const next = generator.next();
    await delay(20);
    assert.equal(timers.size, 0);
    const reason = new Error('stop waiting');
    controller.abort(reason);
    await assert.rejects(next, error => error === reason);
    assert.equal(body.cancellations.length, 1);
});

test('abort also prevents delivery of already buffered events', async t => {
    mockFetch(t, async () => streamResponse(['data: first\n\ndata: second\n\n']));
    const controller = new AbortController();
    const generator = makeSSERequest('https://example.test', 'GET', null, null, null, 0, 0, controller.signal);
    assert.deepEqual(await generator.next(), { done: false, value: 'first' });
    const reason = new Error('stop buffered messages');
    controller.abort(reason);
    await assert.rejects(generator.next(), error => error === reason);
});

test('per-read deadlines reset on chunks rather than complete events', async t => {
    mockFetch(t, async () => {
        const chunks = ['data: ', 'slow', ' message', '\n\n'];
        return new Response(new ReadableStream({
            async pull(controller) {
                await delay(20);
                controller.enqueue(encode(chunks.shift()));
                if (chunks.length === 0) controller.close();
            },
        }));
    });
    assert.deepEqual((await collect(makeSSERequest('https://example.test', 'GET', null, null, null, 1000, 50))).messages, ['slow message']);
});

test('SSE headers are copied and Accept defaults without overriding callers', async t => {
    let request;
    mockFetch(t, async (url, init) => { request = new Request(url, init); return streamResponse(['data: ok\n\n']); });
    const headers = Object.freeze({ 'X-Request': 'one' });
    await collect(makeSSERequest('https://example.test', 'POST', null, headers, { prompt: 'hello' }));
    assert.equal(request.headers.get('accept'), 'text/event-stream');
    assert.deepEqual(await request.json(), { prompt: 'hello' });
    assert.deepEqual(headers, { 'X-Request': 'one' });
    await collect(makeSSERequest('https://example.test', 'GET', null, { accept: 'custom/type' }));
    assert.equal(request.headers.get('accept'), 'custom/type');
});

test('timeout and event-limit validation happens before requesting', async t => {
    const fetch = mockFetch(t, async () => streamResponse([]));
    for (const ms of [-1, 0.5, NaN, Infinity, 2147483648, null, '10']) {
        await assert.rejects(makeSSERequest('https://example.test', 'GET', null, null, null, ms, 0).next());
        await assert.rejects(makeSSERequest('https://example.test', 'GET', null, null, null, 0, ms).next());
    }
    for (const max of [0, -1, 0.5, NaN, Infinity, null]) {
        await assert.rejects(makeSSERequest('https://example.test', 'GET', null, null, null, 0, 0, undefined, max).next());
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test('oversized pending frames and ignored lines are bounded and cancelled', async t => {
    for (const wire of ['data: ' + 'x'.repeat(32), ': ' + 'x'.repeat(32), 'data: a\ndata: b\ndata: c\n']) {
        const body = pendingBody();
        body.controller.enqueue(encode(wire));
        mockFetch(t, async () => new Response(body.stream));
        await assert.rejects(collect(makeSSERequest('https://example.test', 'GET', null, null, null, 0, 0, undefined, 16)), /maxEventBytes/);
        assert.equal(body.cancellations.length, 1);
    }
});

test('many small chunks assemble a large event without changing its payload', async t => {
    const payload = 'x'.repeat(256 * 1024);
    const data = encode('data: ' + payload + '\n\n');
    let offset = 0;
    mockFetch(t, async () => new Response(new ReadableStream({
        pull(controller) {
            if (offset === data.length) { controller.close(); return; }
            const end = Math.min(offset + 32, data.length);
            controller.enqueue(data.subarray(offset, end));
            offset = end;
        },
    })));
    assert.deepEqual((await collect(makeSSERequest('https://example.test', 'GET', null, null, null, 0, 0))).messages, [payload]);
});
