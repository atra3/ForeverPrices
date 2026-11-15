# Forever Prices

Item-tooltip prices for **US Forever PvP Horde**, from Blizzard's Forever auction API.
Shows minimum, 25th percentile and median buyout in copper per unit, plus snapshot age.
Percentiles are quantity-weighted nearest ranks of current listings, not historical prices.
Equipment variants are grouped by base item ID. Bid-only auctions are excluded.

Install the release ZIP into `Interface/AddOns`; disable Oribos Exchange to avoid duplicate lines.
Use this repo's GitHub URL in WowUp. Restart WoW once after installation; update and `/reload` for fresh data.
Prices only display on US PvP Horde characters. No settings, libraries or background work.

## GitHub setup

1. Create a repository and push **this folder's contents** to its default branch, including `.github`.
2. Enable GitHub Actions. Allow `contents: write` and Actions pushes to the default branch
   (Settings → Actions → General; branch rules must permit the bot). This commits prices and publishes releases.
   The workflow uses GitHub's built-in token for commits and releases.
3. Create a client at [Battle.net API access](https://develop.battle.net/access/clients).
   Add its credentials under **Settings → Secrets and variables → Actions → Repository secrets**:
   `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`. Store these in GitHub, not in the repository
   or Cloudflare. The workflow exchanges them for a short-lived read-only auction API token.
4. Run **Actions → Publish prices → Run workflow** for the first release.
5. Add the repository URL to WowUp, or install the ZIP from **Releases**.

Automatic refreshes use an external Cloudflare Worker with the Cron Trigger `17 */2 * * *`
(every two hours, evaluated in UTC). The Worker sends an authenticated POST to GitHub's
`/repos/atra3/ForeverPrices/actions/workflows/prices.yml/dispatches` endpoint with body
`{"ref":"main"}`. Store its fine-grained GitHub token in Cloudflare as a secret named
`GITHUB_TOKEN`, scoped to this repository with **Actions: Read and write** permission.

The workflow runs only on `workflow_dispatch`, from Cloudflare or **Run workflow** in GitHub.
Each invocation fetches prices, commits them and publishes a versioned ZIP. Runs are serialized
to prevent overlapping pushes. Failed downloads or realm snapshots older than six hours do not
publish a release. Check **Actions → Publish prices** for build results.
Authentication failures and HTTP 403 stop the build without retrying or publishing old prices.
Credentials, tokens and authentication response bodies are not logged.
Temporary network errors, HTTP 408/429 and server errors get up to two retries; `Retry-After`
is respected, and cooldowns over two minutes are left for the next scheduled build.

The builder fetches both listings and commodities for Blizzard house **113** in the US
`dynamic-forever-us` namespace. Stack buyouts are divided by quantity (rounded down to copper);
commodities already specify a unit price. Percentiles are weighted by item quantity across both
feeds. Snapshot age uses the older of the two `Last-Modified` timestamps; both must be present
and no older than six hours. The Forever endpoint and house mapping follow the working
[OribosExchange-Forever implementation](https://github.com/ZiiMs/OribosExchange-Forever/blob/main/docs/research/forever-auction-api.md);
Blizzard has not yet documented this namespace. Undermine Exchange is no longer used.

Local refresh: export the same two credential variables, then run `node tools/build.js`
(Node 22+, no npm install). Tests: `node --test tools/build.test.js`.
Other addons: `ForeverPrices.GetPrice(itemID)` returns minimum, quartile, median, snapshot Unix time,
or nil when unavailable.
