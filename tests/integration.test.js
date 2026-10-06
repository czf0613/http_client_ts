import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { makeHttpRequest, makeSSERequest } from '../dist/index.js';

async function serve(t, handler) {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
    });
    return `http://127.0.0.1:${server.address().port}`;
}

test('real Fetch sends correct PATCH data and preserves response metadata through redirects', async t => {
    let received;
    const url = await serve(t, (req, res) => {
        if (req.url === '/redirect') {
            res.writeHead(302, { Location: '/final' });
            res.end();
            return;
        }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            received = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
    });
    const patched = await makeHttpRequest(url + '/items?old=1#section', 'PATCH', { enabled: true }, Object.freeze({ 'content-type': 'application/problem+json' }), { name: 'Ada' });
    assert.deepEqual(await patched.jsonWithTimeout(), { ok: true });
    assert.equal(received.url, '/items?old=1&enabled=true');
    assert.equal(received.method, 'PATCH');
    assert.equal(received.headers['content-type'], 'application/problem+json');
    assert.equal(received.body, '{"name":"Ada"}');
    const redirected = await makeHttpRequest(url + '/redirect');
    assert.equal(redirected.url, url + '/final');
    assert.equal(redirected.redirected, true);
    assert.equal(redirected.status, 201);
    assert.deepEqual(await redirected.json(), { ok: true });
});

test('header timeout aborts the real connection before headers arrive', async t => {
    let markClosed;
    const connectionClosed = new Promise(resolve => { markClosed = resolve; });
    const url = await serve(t, (_req, res) => res.on('close', markClosed));
    await assert.rejects(makeHttpRequest(url, 'GET', null, null, null, 100), { name: 'TimeoutError' });
    await connectionClosed;
});

test('body timeout stops a real streaming download after headers have succeeded', async t => {
    let markClosed;
    const connectionClosed = new Promise(resolve => { markClosed = resolve; });
    let writes = 0;
    const url = await serve(t, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('start');
        const interval = setInterval(() => { writes++; res.write('chunk'); }, 5);
        res.on('close', () => { clearInterval(interval); markClosed(); });
    });
    const response = await makeHttpRequest(url, 'GET', null, null, null, 1000);
    assert.equal(response.status, 200);
    await assert.rejects(response.textWithTimeout(30), { name: 'TimeoutError' });
    await connectionClosed;
    const stoppedAt = writes;
    await delay(20);
    assert.equal(writes, stoppedAt);
});

test('SSE break, idle timeout, and explicit abort close real connections', async t => {
    for (const mode of ['break', 'timeout', 'abort']) {
        await t.test(mode, async t => {
            let markClosed;
            const connectionClosed = new Promise(resolve => { markClosed = resolve; });
            const url = await serve(t, (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('data: first\r\n\r\n');
                res.on('close', markClosed);
            });
            const controller = new AbortController();
            const generator = makeSSERequest(url, 'GET', null, null, null, 1000, mode === 'timeout' ? 30 : 0, controller.signal);
            if (mode === 'break') {
                for await (const value of generator) { assert.equal(value, 'first'); break; }
            } else {
                assert.deepEqual(await generator.next(), { done: false, value: 'first' });
                const pending = generator.next();
                if (mode === 'abort') {
                    const reason = new Error('cancel waiting');
                    controller.abort(reason);
                    await assert.rejects(pending, error => error === reason);
                } else {
                    await assert.rejects(pending, { name: 'TimeoutError' });
                }
            }
            await connectionClosed;
        });
    }
});
