'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const zlib = require('node:zlib');

const source = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
const now = Math.floor(Date.now() / 1000) * 1000;

async function run(respond, stale = false) {
    const state = Buffer.alloc(35);
    state[0] = 4;
    state.writeUInt32LE(now / 1000 - (stale ? 25000 : 0), 1);
    state.writeUInt32LE(1, 11);
    state.writeUInt32LE(123, 15);
    state.writeUInt32LE(4, 31);
    const prices = Buffer.alloc(31);
    prices[0] = 5;
    prices.writeUInt32LE(4, 9);
    prices.writeUInt16LE(2, 13);
    prices.writeUInt32LE(10, 15);
    prices.writeUInt32LE(1, 19);
    prices.writeUInt32LE(20, 23);
    prices.writeUInt32LE(3, 27);

    const result = { calls: [], waits: [], warnings: [], errors: [], writes: [] };
    const process = { exitCode: 0 };
    const session = new EventEmitter();
    session.destroy = () => { session.destroyed = true; };
    session.request = headers => {
        result.calls.push(headers[':path']);
        const response = respond(result.calls.length, headers[':path']);
        const request = new EventEmitter();
        request.setTimeout = () => {};
        request.end = () => queueMicrotask(() => {
            if (response.error) return request.emit('error', response.error);
            request.emit('response', { ':status': response.status || 200, ...response.headers });
            request.emit('data', response.body ?? (headers[':path'].includes('state') ? state : prices));
            request.emit('end');
        });
        return request;
    };
    vm.runInNewContext(source, {
        require(name) {
            if (name === 'node:http2') return { connect: () => session };
            if (name === 'node:fs') return { writeFileSync: (file, content) => result.writes.push(content) };
            return require(name);
        },
        __dirname, Buffer, process,
        Date: class extends Date { static now() { return now; } },
        setTimeout(callback, delay) { result.waits.push(delay); queueMicrotask(callback); },
        console: {
            log() {},
            warn(message) { result.warnings.push(message); },
            error(error) { result.errors.push(String(error)); },
        },
    });
    // All mock requests and timers settle as microtasks before the next event-loop turn.
    await new Promise(setImmediate);
    result.exitCode = process.exitCode;
    return result;
}

test('a complete download produces the expected weighted prices', async () => {
    const r = await run(() => ({}));
    assert.equal(r.exitCode, 0);
    assert.equal(r.writes.length, 1);
    assert.match(r.writes[0], /\[123\]=\{1000,1000,2000\}/);
});

test('gzip 403 reports bounded diagnostics without retries or writes', async () => {
    const r = await run(() => ({ status: 403, headers: {
        'content-type': 'text/html', 'content-encoding': 'gzip',
        server: 'test-server', 'cf-ray': 'test-id', 'set-cookie': 'PRIVATE_COOKIE',
    }, body: zlib.gzipSync('<html>Access denied\n' + 'x'.repeat(1000) + 'NOT_LOGGED</html>') }));
    assert.equal(r.exitCode, 1);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.waits, []);
    assert.deepEqual(r.writes, []);
    assert.match(r.errors[0], /HTTP 403.*server=test-server.*cf-ray=test-id.*Access denied.*denied access/);
    assert.doesNotMatch(r.errors[0], /PRIVATE_COOKIE|NOT_LOGGED/);
});

for (const [label, retryAfter] of [
    ['seconds', '5'], ['HTTP date', new Date(now + 5000).toUTCString()],
]) {
    test(`429 respects Retry-After in ${label} before recovering`, async () => {
        const r = await run(call => call === 1 ? { status: 429, headers: { 'retry-after': retryAfter } } : {});
        assert.equal(r.exitCode, 0);
        assert.deepEqual(r.waits, [5000]);
        assert.equal(r.writes.length, 1);
    });
}

test('a long cooldown fails without retrying early or publishing', async () => {
    const r = await run(() => ({ status: 429, headers: { 'retry-after': '300' } }));
    assert.equal(r.exitCode, 1);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.waits, []);
    assert.deepEqual(r.writes, []);
});

for (const failure of [{ status: 503 }, { error: new Error('Connection reset') }]) {
    test(`a temporary ${failure.status || 'network'} error recovers`, async () => {
        const r = await run(call => call === 1 ? failure : {});
        assert.equal(r.exitCode, 0);
        assert.deepEqual(r.waits, [1000]);
        assert.equal(r.writes.length, 1);
    });
}

test('persistent server errors stop after two retries without writing', async () => {
    const r = await run(() => ({ status: 503 }));
    assert.equal(r.exitCode, 1);
    assert.equal(r.calls.length, 3);
    assert.deepEqual(r.waits, [1000, 2000]);
    assert.deepEqual(r.writes, []);
});

test('an item denial preserves existing prices after a successful state download', async () => {
    const r = await run(call => call === 1 ? {} : { status: 403 });
    assert.equal(r.exitCode, 1);
    assert.equal(r.calls.length, 2);
    assert.deepEqual(r.waits, []);
    assert.deepEqual(r.writes, []);
});

test('stale snapshot data never overwrites prices', async () => {
    const r = await run(() => ({}), true);
    assert.equal(r.exitCode, 1);
    assert.match(r.errors[0], /stale/);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.writes, []);
});
