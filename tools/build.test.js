'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
const now = Math.floor(Date.now() / 1000) * 1000;
const credentials = { BLIZZARD_CLIENT_ID: 'TEST_CLIENT_ID', BLIZZARD_CLIENT_SECRET: 'TEST_CLIENT_SECRET' };
const token = 'TEST_ACCESS_TOKEN';
const listings = [
    { item: { id: 123, bonus_lists: [1] }, quantity: 3, buyout: 6000 },
    { item: { id: 123, bonus_lists: [2] }, quantity: 1, buyout: 1000 },
    { item: { id: 999 }, quantity: 1, bid: 100, buyout: 0 },
    { item: { id: 998 }, quantity: 1, bid: 100 },
];
const commodities = [
    { item: { id: 456 }, quantity: 50, unit_price: 21 },
    { item: { id: 456 }, quantity: 10, unit_price: 17 },
];

async function run(respond = () => ({}), env = credentials) {
    const result = { calls: [], waits: [], warnings: [], errors: [], writes: [], logs: [] };
    const process = { exitCode: 0, env };
    vm.runInNewContext(source, {
        require(name) {
            if (name === 'node:fs') return { writeFileSync: (file, content) => result.writes.push(content) };
            return require(name);
        },
        __dirname, Buffer, URL, AbortController, AbortSignal, process,
        Date: class extends Date { static now() { return now; } },
        setTimeout(callback, delay) { result.waits.push(delay); queueMicrotask(callback); },
        async fetch(url, options) {
            const resource = url.includes('/token') ? 'auth' : url.includes('/commodities') ? 'commodities' : 'listings';
            const call = { url, options, resource };
            result.calls.push(call);
            const response = respond(call, result.calls.length) || {};
            if (response.error) throw response.error;
            const defaults = resource === 'auth' ? { access_token: token } : {
                auctions: resource === 'listings' ? listings : commodities,
            };
            const data = Object.hasOwn(response, 'data') ? response.data : defaults;
            const headers = resource === 'auth' ? {} : { 'last-modified': new Date(now - 3600000).toUTCString() };
            return new Response(response.raw ?? JSON.stringify(data), {
                status: response.status || 200,
                headers: { 'content-type': 'application/json', ...headers, ...response.headers },
            });
        },
        console: {
            log(message) { result.logs.push(message); },
            warn(message) { result.warnings.push(message); },
            error(error) { result.errors.push(String(error)); },
        },
    });
    // Mock responses and waits settle as microtasks before the next event-loop turn.
    await new Promise(setImmediate);
    result.exitCode = process.exitCode;
    return result;
}

function failsWithoutWrite(result, message) {
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.writes, []);
    assert.match(result.errors[0], message);
}

test('OAuth and two house 113 feeds preserve weighted current buyout prices', async () => {
    const r = await run();
    assert.equal(r.exitCode, 0);
    assert.equal(r.calls.length, 3);
    const [auth, ...feeds] = r.calls;
    assert.equal(auth.url, 'https://oauth.battle.net/token');
    assert.equal(auth.options.method, 'POST');
    assert.equal(auth.options.body, 'grant_type=client_credentials');
    assert.equal(auth.options.headers.Authorization, 'Basic ' + Buffer.from('TEST_CLIENT_ID:TEST_CLIENT_SECRET').toString('base64'));
    assert.deepEqual(feeds.map(f => f.url), [
        'https://us.api.blizzard.com/data/wow/ruleset/2/auctions/113?namespace=dynamic-forever-us',
        'https://us.api.blizzard.com/data/wow/ruleset/2/auctions/113/commodities?namespace=dynamic-forever-us',
    ]);
    for (const feed of feeds) {
        assert.equal(feed.options.headers.Authorization, `Bearer ${token}`);
        assert.equal(feed.options.redirect, 'error');
    }
    assert.equal(r.writes.length, 1);
    const output = r.writes[0];
    assert.match(output, /\[123\]=\{1000,1000,2000\}/); // Stack buyout / quantity; combine equipment variations.
    assert.match(output, /\[456\]=\{17,21,21\}/); // Weight commodity units, not auction rows.
    assert.doesNotMatch(output, /\[99[89]\]/); // Bid-only auctions.
    assert.ok(output.indexOf('[123]') < output.indexOf('[456]'));
    assert.match(output, new RegExp(`addon.updated = ${(now - 3600000) / 1000}`));
    assert.doesNotMatch(JSON.stringify([...r.logs, ...r.errors, ...r.warnings]), /TEST_CLIENT_SECRET|TEST_ACCESS_TOKEN/);
});

test('missing credentials fail before making any network requests', async () => {
    const r = await run(undefined, { BLIZZARD_CLIENT_ID: '  ' });
    failsWithoutWrite(r, /BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET/);
    assert.deepEqual(r.calls, []);
});

for (const status of [401, 403]) {
    test(`authentication HTTP ${status} is not retried and never leaks the response`, async () => {
        const r = await run(() => ({ status, data: { error: 'TEST_CLIENT_SECRET TEST_ACCESS_TOKEN' } }));
        failsWithoutWrite(r, new RegExp(`HTTP ${status}`));
        assert.equal(r.calls.length, 1);
        assert.deepEqual(r.waits, []);
        assert.doesNotMatch(r.errors[0], /TEST_CLIENT_SECRET|TEST_ACCESS_TOKEN/);
    });
}

test('a missing token cannot reach the auction API', async () => {
    const r = await run(() => ({ data: { access_token: '' } }));
    failsWithoutWrite(r, /no access token/);
    assert.equal(r.calls.length, 1);
});

for (const resource of ['listings', 'commodities']) {
    test(`a failure of the ${resource} feed prevents partial prices`, async () => {
        const r = await run(call => call.resource === resource ? { status: 403 } : {});
        failsWithoutWrite(r, /HTTP 403/);
        assert.deepEqual(r.waits, []);
    });
}

for (const [label, lastModified] of [
    ['stale', new Date(now - 7 * 3600000).toUTCString()],
    ['future', new Date(now + 600000).toUTCString()],
    ['missing', ''],
    ['invalid', 'not-a-date'],
]) {
    test(`a ${label} source timestamp fails even if the other feed is fresh`, async () => {
        const r = await run(call => call.resource === 'commodities' ? { headers: { 'last-modified': lastModified } } : {});
        failsWithoutWrite(r, /snapshot timestamp/);
    });
}

test('snapshot age comes from the older of the two feeds', async () => {
    const r = await run(call => call.resource === 'commodities'
        ? { headers: { 'last-modified': new Date(now - 2 * 3600000).toUTCString() } } : {});
    assert.equal(r.exitCode, 0);
    assert.match(r.writes[0], new RegExp(`addon.updated = ${(now - 2 * 3600000) / 1000}`));
});

for (const [label, response] of [
    ['invalid JSON', { raw: '{PRIVATE_RESPONSE' }],
    ['missing auctions', { data: {} }],
    ['invalid quantity', { data: { auctions: [{ item: { id: 1 }, quantity: 0, buyout: 100 }] } }],
    ['invalid item', { data: { auctions: [{ quantity: 1, buyout: 100 }] } }],
    ['invalid buyout', { data: { auctions: [{ item: { id: 1 }, quantity: 1, buyout: -1 }] } }],
    ['invalid unit price', { data: { auctions: [{ item: { id: 1 }, quantity: 1, unit_price: null }] } }],
]) {
    test(`${label} does not overwrite the previous file`, async () => {
        const r = await run(call => call.resource === 'commodities' ? response : {});
        failsWithoutWrite(r, /Invalid|Missing/);
        assert.doesNotMatch(r.errors[0], /PRIVATE_RESPONSE/);
    });
}

test('two empty feeds cannot publish an empty price table', async () => {
    const r = await run(call => call.resource !== 'auth' ? { data: { auctions: [] } } : {});
    failsWithoutWrite(r, /Missing Blizzard buyout prices/);
});

test('one empty feed is allowed when both feeds have valid timestamps', async () => {
    const r = await run(call => call.resource === 'commodities' ? { data: { auctions: [] } } : {});
    assert.equal(r.exitCode, 0);
    assert.match(r.writes[0], /\[123\]/);
});

for (const [label, retryAfter] of [
    ['seconds', '5'], ['HTTP date', new Date(now + 5000).toUTCString()],
]) {
    test(`429 respects Retry-After in ${label} before recovering`, async () => {
        const r = await run((call, count) => count === 1 ? { status: 429, headers: { 'retry-after': retryAfter } } : {});
        assert.equal(r.exitCode, 0);
        assert.deepEqual(r.waits, [5000]);
        assert.equal(r.writes.length, 1);
    });
}

test('a long cooldown fails without retrying early or publishing', async () => {
    const r = await run(() => ({ status: 429, headers: { 'retry-after': '300' } }));
    failsWithoutWrite(r, /HTTP 429/);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.waits, []);
});

for (const failure of [{ status: 503 }, { error: new Error('Connection reset') }]) {
    test(`a temporary ${failure.status || 'network'} error recovers`, async () => {
        const r = await run((call, count) => count === 1 ? failure : {});
        assert.equal(r.exitCode, 0);
        assert.deepEqual(r.waits, [1000]);
        assert.equal(r.writes.length, 1);
    });
}

test('persistent server errors stop after two retries without writing', async () => {
    const r = await run(() => ({ status: 503 }));
    failsWithoutWrite(r, /HTTP 503/);
    assert.equal(r.calls.length, 3);
    assert.deepEqual(r.waits, [1000, 2000]);
});
