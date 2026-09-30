/**
 * Check a tracking link the way the dashboard does.
 *   node scripts/check-tracking-page.js "<tracking url>"            -> status + delivered date it reads
 *   node scripts/check-tracking-page.js "<tracking url>" --save raw.html  -> also saves the raw HTML
 * If the date isn't picked up for a link, save the raw HTML and send it
 * over (remove anything private first) so the parser can be adjusted.
 */
const fs = require('fs');
const { fetchRawPage, parseTrackingHtml } = require('../services/trackingPageService');

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('Pass a tracking URL as the first argument.');
    process.exit(1);
  }
  const page = await fetchRawPage(url);
  if (page.error) return console.log('Fetch failed:', page.error);
  console.log('HTTP', page.httpStatus, '-', page.html.length, 'bytes');
  const saveIdx = process.argv.indexOf('--save');
  if (saveIdx > -1) {
    const file = process.argv[saveIdx + 1] || 'raw.html';
    fs.writeFileSync(file, page.html);
    console.log('Saved raw HTML to', file);
  }
  const parsed = parseTrackingHtml(page.html, /shiprocket\.co\/tracking\//i.test(url));
  console.log(parsed.deliveredDate ? { ...parsed, deliveredDate: parsed.deliveredDate.toDateString() } : parsed);
})();
