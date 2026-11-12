# Forever Prices

Item-tooltip prices for **US Forever PvP Horde**, from [Undermine Exchange](https://undermine.exchange/#usf-pvp-horde).
Shows minimum, 25th percentile and median buyout in copper per unit, plus snapshot age.
Percentiles are quantity-weighted nearest ranks of current listings, not historical prices.
Equipment variants are grouped by base item ID, matching Undermine's free view.

Install the release ZIP into `Interface/AddOns`; disable Oribos Exchange to avoid duplicate lines.
Use this repo's GitHub URL in WowUp. Restart WoW once after installation; update and `/reload` for fresh data.
Prices only display on US PvP Horde characters. No settings, libraries or background work.

## GitHub setup

1. Create a repository and push **this folder's contents** to its default branch, including `.github`.
2. Enable GitHub Actions. Allow `contents: write` and Actions pushes to the default branch
   (Settings → Actions → General; branch rules must permit the bot). This commits prices and publishes releases.
   No API keys, PAT, repository variables or external scheduler are needed.
3. Run **Actions → Publish prices → Run workflow** for the first release.
4. Add the repository URL to WowUp, or install the ZIP from **Releases**.

The workflow aims to download this house's current item distributions and publish a versioned ZIP
once per **two-hour UTC window** (00:00–01:59, 02:00–03:59, and so on). It checks at minutes
**17, 37 and 57 of every hour**, skipping the download and release if a release has already been
published in the current window. These extra checks give missed triggers and failed builds another
chance; manual runs always refresh immediately. The gate checks published releases, so a failed
release can be retried even if its price commit succeeded.

GitHub schedules are best effort: triggers can be delayed or dropped, so this cannot guarantee
an exact two-hour interval. Use an external scheduler to dispatch the workflow if that is required.
Check **Actions → Publish prices** for actual runs; commit history only shows builds that reached
the commit step. Public repositories' schedules are disabled after 60 days without repository
activity; re-enable the workflow if that happens. Failed downloads or realm snapshots older than
six hours do not publish a release.

Local refresh: `node tools/build.js` (Node 22+, no npm install).
Other addons: `ForeverPrices.GetPrice(itemID)` returns minimum, quartile, median, snapshot Unix time,
or nil when unavailable. Binary format follows Undermine's [public client](https://github.com/erorus/shatari-front/blob/master/src/ts/Auctions.ts).
