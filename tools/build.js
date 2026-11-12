'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http2 = require('node:http2');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const house = 33137; // undermine.exchange/#usf-pvp-horde
const site = 'https://undermine.exchange';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Public binary formats used by undermine.exchange's client (Auctions.ts).
// Prices encode silver, copper or gold in their top two bits.
function price(encoded) {
    const amount = encoded & 0x3fffffff;
    switch (encoded >>> 30) {
        case 0: return amount * 100;
        case 1: return amount;
        case 2: return amount * 10000;
        default: throw new Error('Unknown price encoding');
    }
}

function readState(buffer) {
    if (![3, 4].includes(buffer[0])) throw new Error('Unknown realm data version');
    const snapshot = buffer.readUInt32LE(1);
    let offset = 11 + buffer.readUInt16LE(9) * 4;
    const count = buffer.readUInt32LE(offset);
    offset += 4;
    const items = [];
    for (let i = 0; i < count; i++, offset += 20) {
        const id = buffer.readUInt32LE(offset);
        const level = buffer.readUInt16LE(offset + 4);
        const suffix = buffer.readUInt16LE(offset + 6);
        const quantity = buffer.readUInt32LE(offset + 16);
        if (!level && !suffix && quantity > 0) items.push(id);
    }
    return { snapshot, items: [...new Set(items)].sort((a, b) => a - b) };
}

function readPrices(buffer) {
    if (![3, 4, 5].includes(buffer[0])) throw new Error('Unknown item data version');
    const quantity = buffer.readUInt32LE(9);
    if (!quantity) return null;
    const count = buffer.readUInt16LE(13);
    const auctions = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
        const unit = price(buffer.readUInt32LE(15 + i * 8));
        const units = buffer.readUInt32LE(19 + i * 8);
        if (unit <= 0 || units <= 0) throw new Error('Invalid auction price or quantity');
        auctions.push([unit, units]);
        total += units;
    }
    if (total !== quantity) throw new Error('Incomplete auction distribution');
    auctions.sort((a, b) => a[0] - b[0]);
    // Weighted nearest rank: the first price reaching 25% / 50% of units.
    const rank25 = Math.ceil(total * 0.25), rank50 = Math.ceil(total * 0.5);
    let seen = 0, quartile, median;
    for (const [unit, units] of auctions) {
        seen += units;
        if (quartile === undefined && seen >= rank25) quartile = unit;
        if (seen >= rank50) { median = unit; break; }
    }
    return [auctions[0][0], quartile, median];
}

async function build() {
    let client;
    let stopped = false;
    const connections = new Set();
    function connection() {
        if (!client || client.closed || client.destroyed) {
            const current = client = http2.connect(site);
            connections.add(current);
            current.on('error', () => current.destroy()); // Streams report the error.
            current.on('close', () => connections.delete(current));
            current.on('goaway', () => {
                if (client === current) client = null;
                current.close(); // Let active streams finish; new requests reconnect.
            });
        }
        return client;
    }
    async function download(url) {
        for (let attempt = 0; ; attempt++) {
            if (stopped) throw new Error('Build stopped');
            try {
                return await new Promise((resolve, reject) => {
                    const request = connection().request({ ':path': url, 'accept-encoding': 'gzip',
                        'user-agent': 'ForeverPrices/1.0 (personal WoW addon)', referer: site + '/' });
                    let headers;
                    const chunks = [];
                    request.setTimeout(30000, () => request.destroy(new Error('Download timed out')));
                    request.on('response', value => { headers = value; });
                    request.on('data', chunk => chunks.push(chunk));
                    request.on('error', reject);
                    request.on('end', () => {
                        try {
                            if (headers?.[':status'] !== 200) throw new Error(`HTTP ${headers?.[':status']}: ${url}`);
                            let body = Buffer.concat(chunks);
                            if (headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
                            resolve(body);
                        } catch (error) { reject(error); }
                    });
                    request.end();
                });
            } catch (error) {
                if (attempt >= 2 || stopped) throw error;
                await pause(1000 * (attempt + 1));
            }
        }
    }
    try {
        const { snapshot, items } = readState(await download(`/data/${house}/state.free.bin`));
        if (!items.length || snapshot > Date.now() / 1000 + 300 || Date.now() / 1000 - snapshot > 6 * 3600) {
            throw new Error('Missing or stale realm snapshot; keeping existing prices');
        }
        console.log(`US PvP Horde: ${items.length} items; snapshot ${new Date(snapshot * 1000).toISOString()}`);
        const rows = new Map();
        let next = 0, done = 0;
        // Four requests at a time, one house only. No histories or region data.
        await Promise.all(Array.from({ length: 4 }, async () => {
            while (next < items.length) {
                const id = items[next++];
                const values = readPrices(await download(`/data/${house}/${id & 255}/${id}.bin`));
                if (values) rows.set(id, values);
                if (++done % 250 === 0) console.log(`${done}/${items.length}`);
            }
        }));
        if (!rows.size || Date.now() / 1000 - snapshot > 6 * 3600) {
            throw new Error('Missing or stale prices; keeping existing prices');
        }
        const lines = ['-- Generated from Undermine Exchange: US Forever PvP Horde.',
            'local _, addon = ...', `addon.updated = ${snapshot}`, 'addon.prices = {'];
        for (const id of items) {
            const values = rows.get(id);
            if (values) lines.push(`[${id}]={${values.join(',')}},`);
        }
        lines.push('}', '');
        // Do not touch the working data unless the entire download succeeded.
        fs.writeFileSync(path.join(root, 'Prices.lua'), lines.join('\n'));
        console.log(`Wrote ${rows.size} item prices`);
    } finally {
        stopped = true;
        for (const current of connections) current.destroy();
    }
}

build().catch(error => { console.error(error); process.exitCode = 1; });
