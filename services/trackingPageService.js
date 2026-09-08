const axios = require('axios');

/**
 * Live status straight off a public shiprocket.co tracking page — works
 * across EVERY courier Shiprocket routes through (Delhivery, Xpressbees,
 * etc.), since it's the same aggregator page no matter which carrier
 * actually delivers it. Shiprocket has no public tracking API without an
 * account, so this is a best-effort HTML scrape of the page's rendered
 * content, which IS embedded server-side in the initial response (not
 * loaded later via JS) — confirmed by fetching it directly.
 *
 * This is inherently fragile — if Shiprocket redesigns the page's
 * markup, these patterns can stop matching — but right now it's the
 * single most reliable live source across the whole order base, since
 * every tracking link is a shiprocket.co URL regardless of courier.
 */

// Checked in order — more specific phrases before generic ones, so
// e.g. "returned"/"RTO Delivered" match before the plainer "Delivered"
// or bare "rto" would. A completed return maps to the single flat 'RTO'
// status (matching Delhivery's own public wording, "Returned"), not a
// vaguer "RTO In Transit".
const STATUS_KEYWORDS = [
  { re: /rto\s*delivered/i, status: 'RTO' },
  { re: /\breturned\b/i, status: 'RTO' },
  { re: /return\s*accepted/i, status: 'RTO' }, // Delhivery's "Shipment return accepted" phrasing — same fix as delhiveryService.js
  { re: /rto\s*initiat/i, status: 'RTO Initiated' },
  { re: /\brto\b/i, status: 'RTO In Transit' },
  { re: /undelivered/i, status: 'Failed Delivery' },
  { re: /out\s*for\s*delivery/i, status: 'In Transit' },
  { re: /\bdelivered\b/i, status: 'Delivered' },
  { re: /in\s*transit/i, status: 'In Transit' },
  { re: /reached\s*at\s*destination/i, status: 'In Transit' },
  { re: /out\s*for\s*pickup/i, status: 'Manifested' },
  { re: /pickup\s*(done|generated|scheduled)/i, status: 'Dispatched' },
  { re: /data\s*received/i, status: 'Manifested' },
  { re: /\bpending\b/i, status: 'Pending' },
  { re: /\bcancelled\b/i, status: 'Cancelled' },
  { re: /\blost\b/i, status: 'Lost' },
];

// The page shows the CURRENT status once, right after "Estimated
// Delivery Date" near the top, then a full historical activity log
// below that repeats status words many times (every past scan). Isolate
// just that current-status block so a search doesn't latch onto old
// history instead of the live status.
function isolateCurrentStatusBlock(html) {
  const statusIdx = html.search(/Status\s*:/i);
  if (statusIdx === -1) return html.slice(0, 1200);
  const rest = html.slice(statusIdx);
  const activityIdx = rest.search(/Activity\s*:/i);
  return activityIdx === -1 ? rest.slice(0, 800) : rest.slice(0, activityIdx);
}

function mapStatusBlock(block) {
  // Prefer the status icon's filename if present — Shiprocket uses a
  // small, consistent set of icon slugs (e.g. ".../tracking/undelivered.svg"),
  // which is a more reliable single signal than surrounding page text.
  const iconMatch = block.match(/tracking\/([a-z_-]+)\.svg/i);
  if (iconMatch) {
    const slug = iconMatch[1].toLowerCase();
    for (const { re, status } of STATUS_KEYWORDS) {
      if (re.test(slug)) return status;
    }
  }
  for (const { re, status } of STATUS_KEYWORDS) {
    if (re.test(block)) return status;
  }
  return null;
}

/**
 * Fetches and parses a shiprocket.co tracking page.
 * Returns { packagedStatus } on success, { notFound: true } if the page
 * loaded but no recognizable status was found, or { error } on a
 * network/HTTP failure. Returns null if `url` isn't a shiprocket.co URL
 * at all, so callers can skip this tier cleanly for other domains.
 */
async function fetchTrackingPageStatus(url) {
  if (!url || !/shiprocket\.co\/tracking\//i.test(url)) return null;

  let res;
  try {
    res = await axios.get(url, {
      timeout: 20000,
      validateStatus: () => true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
  } catch (err) {
    return { error: err.message };
  }
  if (res.status !== 200) return { error: `HTTP ${res.status}` };

  const html = String(res.data);
  const block = isolateCurrentStatusBlock(html);
  const packagedStatus = mapStatusBlock(block);
  return packagedStatus ? { packagedStatus } : { notFound: true };
}

module.exports = { fetchTrackingPageStatus };
