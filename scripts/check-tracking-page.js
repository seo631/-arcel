/**
 * Quick check of a tracking link: prints the status and delivered date the
 * dashboard would read from it.  Usage:
 *   node scripts/check-tracking-page.js "https://shiprocket.co/tracking/<awb>"
 * Run this on a couple of delivered links to confirm the date matches what
 * the page shows in your browser.
 */
const { fetchTrackingPageStatus } = require('../services/trackingPageService');

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('Pass a tracking URL as the first argument.');
    process.exit(1);
  }
  const r = await fetchTrackingPageStatus(url);
  if (r === null) return console.log('Not a shiprocket.co tracking URL — skipped (no other page parsers exist).');
  console.log(r.deliveredDate ? { ...r, deliveredDate: r.deliveredDate.toDateString() } : r);
})();
