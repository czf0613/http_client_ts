import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

async function npm(args, cwd) {
    const command = process.env.npm_execpath ? process.execPath : 'npm';
    const parameters = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
    return exec(command, parameters, { cwd, timeout: 5000 });
}

test('the packed package installs offline and imports by name in native Node', async t => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'http-client-package-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const { stdout } = await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root);
    const [packed] = JSON.parse(stdout);
    const files = packed.files.map(file => file.path);
    assert.ok(files.includes('dist/index.js'));
    assert.ok(files.includes('dist/index.d.ts'));
    assert.ok(!files.some(file => file.startsWith('tests/') || file.startsWith('src/')));
    const consumer = path.join(temporary, 'consumer');
    await mkdir(consumer);
    await writeFile(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
    await npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', path.join(temporary, packed.filename)], consumer);
    const imported = await exec(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import * as api from '@czf0613/http_client';
        assert.deepEqual(Object.keys(api).sort(), ['joinUrlWithParams', 'makeHttpRequest', 'makeSSERequest']);
        const response = await api.makeHttpRequest('data:application/json,%7B%22ok%22%3Atrue%7D');
        assert.deepEqual(await response.jsonWithTimeout(), { ok: true });
        console.log('native package import passed');
    `], { cwd: consumer, timeout: 2000 });
    assert.match(imported.stdout, /native package import passed/);
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
});

test('completed requests and SSE do not keep a Node process alive until old deadlines', async () => {
    const entry = pathToFileURL(path.join(root, 'dist/index.js')).href;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
        import { makeHttpRequest, makeSSERequest } from ${JSON.stringify(entry)};
        globalThis.fetch = async () => new Response('ok');
        const response = await makeHttpRequest('https://example.test', 'GET', null, null, null, 60000);
        await response.textWithTimeout(60000);
        globalThis.fetch = async () => { throw new Error('synthetic failure'); };
        try { await makeHttpRequest('https://example.test', 'GET', null, null, null, 60000); } catch {}
        globalThis.fetch = async () => new Response('data: ok\\n\\n');
        for await (const value of makeSSERequest('https://example.test')) {}
        console.log('finished naturally');
    `], { cwd: root, timeout: 2000 });
    assert.match(stdout, /finished naturally/);
});
