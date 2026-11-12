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

The workflow downloads this house's current item distributions and publishes a versioned ZIP
at **00:17, 02:17, …, 22:17 UTC**. GitHub cron can run late; public repositories' schedules
are disabled after 60 days without repository activity. Re-enable the workflow if that happens.
Failed downloads or realm snapshots older than six hours do not publish a release.

Local refresh: `node tools/build.js` (Node 22+, no npm install).
Other addons: `ForeverPrices.GetPrice(itemID)` returns minimum, quartile, median, snapshot Unix time,
or nil when unavailable. Binary format follows Undermine's [public client](https://github.com/erorus/shatari-front/blob/master/src/ts/Auctions.ts).
