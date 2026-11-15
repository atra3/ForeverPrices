'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// Blizzard's Forever house 113 is US PvP Horde. The ruleset path is an entry point;
// the house ID selects the actual ruleset/faction (see README's source reference).
const house = 'https://us.api.blizzard.com/data/wow/ruleset/2/auctions/113';
const namespace = '?namespace=dynamic-forever-us';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function snapshotTime(lastModified) {
    const snapshot = Math.floor(Date.parse(lastModified) / 1000);
    if (!Number.isFinite(snapshot) || snapshot > Date.now() / 1000 + 300 || Date.now() / 1000 - snapshot > 6 * 3600) {
        throw new Error('Missing, invalid or stale Blizzard snapshot timestamp; keeping existing prices');
    }
    return snapshot;
}

function addAuctions(rows, data) {
    if (!Array.isArray(data?.auctions)) throw new Error('Missing Blizzard auctions array');
    for (const auction of data.auctions) {
        const id = auction?.item?.id;
        const quantity = auction?.quantity;
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0) {
            throw new Error('Invalid auction item or quantity');
        }
        let unit;
        if (auction.unit_price !== undefined) {
            unit = auction.unit_price;
        } else {
            // Equipment/listing buyout is the whole stack; commodities specify unit_price.
            if (auction.buyout === undefined || auction.buyout === 0) continue; // Bid-only.
            if (!Number.isSafeInteger(auction.buyout) || auction.buyout < 0) throw new Error('Invalid auction buyout');
            unit = Math.floor(auction.buyout / quantity);
        }
        if (!Number.isSafeInteger(unit) || unit <= 0) throw new Error('Invalid auction unit price');
        if (!rows.has(id)) rows.set(id, []);
        // All equipment variations share the base item ID.
        rows.get(id).push([unit, quantity]);
    }
}

function prices(auctions) {
    auctions.sort((a, b) => a[0] - b[0]);
    const total = auctions.reduce((sum, [, quantity]) => sum + quantity, 0);
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Invalid auction distribution');
    // Weighted nearest rank: the first price reaching 25% / 50% of units.
    const rank25 = Math.ceil(total * 0.25), rank50 = Math.ceil(total * 0.5);
    let seen = 0, quartile, median;
    for (const [unit, quantity] of auctions) {
        seen += quantity;
        if (quartile === undefined && seen >= rank25) quartile = unit;
        if (seen >= rank50) { median = unit; break; }
    }
    return [auctions[0][0], quartile, median];
}

async function build() {
    const id = process.env.BLIZZARD_CLIENT_ID;
    const secret = process.env.BLIZZARD_CLIENT_SECRET;
    if (!id?.trim() || !secret?.trim()) {
        throw new Error('Set BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET in GitHub Actions repository secrets');
    }
    const controller = new AbortController();
    async function download(url, options) {
        const label = new URL(url).hostname + new URL(url).pathname;
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await fetch(url, {
                    ...options,
                    redirect: 'error',
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
                });
                if (!response.ok) {
                    const error = new Error(`Blizzard HTTP ${response.status}: ${label}`);
                    error.statusCode = response.status;
                    error.retryAfter = response.headers.get('retry-after');
                    // Authentication errors can contain sensitive material: never log bodies/headers.
                    await response.body?.cancel();
                    throw error;
                }
                let data;
                try { data = await response.json(); }
                catch {
                    const error = new Error(`Invalid Blizzard JSON: ${label}`);
                    error.retryable = false;
                    throw error;
                }
                return { data, lastModified: response.headers.get('last-modified') };
            } catch (error) {
                const status = error.statusCode;
                const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
                if (attempt >= 2 || controller.signal.aborted || error.retryable === false || !retryable) throw error;
                let delay = 1000 * (attempt + 1);
                if (error.retryAfter != null) {
                    const seconds = Number(error.retryAfter);
                    const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(error.retryAfter) - Date.now();
                    if (Number.isFinite(requested)) delay = Math.max(delay, requested);
                }
                // Respect a longer cooldown by leaving the next attempt to the scheduler.
                if (delay > 120000) throw error;
                console.warn(`${error.message}; retrying in ${delay / 1000}s (${attempt + 1}/2)`);
                await pause(delay);
            }
        }
    }
    try {
        const { data: auth } = await download('https://oauth.battle.net/token', {
            method: 'POST',
            headers: {
                Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials',
        });
        if (typeof auth?.access_token !== 'string' || !auth.access_token.trim()) {
            throw new Error('Blizzard authentication returned no access token');
        }
        const options = { headers: { Authorization: `Bearer ${auth.access_token}`, 'Accept-Encoding': 'gzip' } };
        const feeds = await Promise.all([
            download(house + namespace, options),
            download(house + '/commodities' + namespace, options),
        ]);
        // Both feeds must have valid source timestamps, even when one has no auctions.
        const snapshot = Math.min(...feeds.map(feed => snapshotTime(feed.lastModified)));
        const rows = new Map();
        for (const feed of feeds) addAuctions(rows, feed.data);
        if (!rows.size) throw new Error('Missing Blizzard buyout prices; keeping existing prices');
        const lines = ['-- Generated from Blizzard auction data: US Forever PvP Horde.',
            'local _, addon = ...', `addon.updated = ${snapshot}`, 'addon.prices = {'];
        for (const id of [...rows.keys()].sort((a, b) => a - b)) {
            lines.push(`[${id}]={${prices(rows.get(id)).join(',')}},`);
        }
        lines.push('}', '');
        snapshotTime(new Date(snapshot * 1000).toUTCString()); // Recheck after processing.
        // Keep the current file unless authentication, both downloads and parsing all succeed.
        fs.writeFileSync(path.join(root, 'Prices.lua'), lines.join('\n'));
        console.log(`US Forever PvP Horde (house 113): wrote ${rows.size} item prices; snapshot ${new Date(snapshot * 1000).toISOString()}`);
    } finally {
        controller.abort();
    }
}

build().catch(error => { console.error(error); process.exitCode = 1; });
