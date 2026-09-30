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


// ---------- Delivered-date extraction ----------
// The status keywords above tell us WHETHER it's delivered; this pulls
// out WHEN. The page's markup isn't documented anywhere, so this is
// deliberately defensive: (1) look for an explicit delivered-date key in
// any embedded JSON, then (2) fall back to the date printed closest to
// the "Delivered" entry in the activity log. If neither finds a date it
// returns null and the caller leaves the field blank rather than guess.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';

function makeDate(y, m, d) {
  const date = new Date(y, m, d); // local midnight, same convention as delhiveryService.toDDMMYYYY
  return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date : null;
}

// Every date-looking thing in `text`, with its position, so the caller
// can pick the one nearest the "Delivered" word.
function findDates(text) {
  const found = [];
  const push = (index, date) => { if (date) found.push({ index, date }); };
  let m;

  const iso = /(\d{4})-(\d{2})-(\d{2})/g;
  while ((m = iso.exec(text))) push(m.index, makeDate(+m[1], +m[2] - 1, +m[3]));

  const dmy = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-,.]+${MON}[\\s\\-,.]+(\\d{4})`, 'gi');
  while ((m = dmy.exec(text))) push(m.index, makeDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]));

  const mdy = new RegExp(`${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'gi');
  while ((m = mdy.exec(text))) push(m.index, makeDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]));

  const slash = /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/g; // India: DD/MM/YYYY
  while ((m = slash.exec(text))) push(m.index, makeDate(+m[3], +m[2] - 1, +m[1]));

  // Year-less "5 Sep" / "Sep 5" — only used if nothing with a year matched.
  if (!found.length) {
    const noYearA = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}\\b`, 'gi');
    const noYearB = new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
    const now = new Date();
    const withYear = (mon, day) => {
      let d = makeDate(now.getFullYear(), mon, day);
      if (d && d > now) d = makeDate(now.getFullYear() - 1, mon, day); // can't be delivered in the future
      return d;
    };
    while ((m = noYearA.exec(text))) push(m.index, withYear(MONTHS[m[2].toLowerCase()], +m[1]));
    while ((m = noYearB.exec(text))) push(m.index, withYear(MONTHS[m[1].toLowerCase()], +m[2]));
  }
  return found;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function extractDeliveredDate(html) {
  // 1) Explicit key in embedded JSON, e.g. "delivered_date":"2026-09-05 14:32:00"
  const keyRe = /["'](?:delivered_date|delivery_date|delivered_at|deliveredDate|deliveredOn|delivered_on)["']\s*:\s*["']([^"']+)["']/gi;
  let km;
  while ((km = keyRe.exec(html))) {
    const dates = findDates(km[1]);
    if (dates.length) return dates[0].date;
  }

  // 2) Nearest date to a genuine "Delivered" entry in the activity log.
  //    \bdelivered\b already excludes "Undelivered"; skip RTO/return
  //    phrasing so a returned parcel's "delivered to origin" isn't
  //    mistaken for the customer delivery.
  const text = htmlToText(html);
  const actIdx = text.search(/Activity\s*:?/i);
  const scopes = actIdx === -1 ? [text] : [text.slice(actIdx), text];
  for (const scope of scopes) {
    const wordRe = /\bdelivered\b/gi;
    let wm;
    while ((wm = wordRe.exec(scope))) {
      const before = scope.slice(Math.max(0, wm.index - 12), wm.index);
      const after = scope.slice(wm.index, wm.index + 24);
      if (/rto|return|origin/i.test(before) || /origin/i.test(after)) continue;

      const from = Math.max(0, wm.index - 120);
      const windowText = scope.slice(from, wm.index + 160);
      const dates = findDates(windowText);
      if (!dates.length) continue;
      const anchor = wm.index - from;
      dates.sort((a, b) => Math.abs(a.index - anchor) - Math.abs(b.index - anchor));
      return dates[0].date;
    }
  }
  return null;
}

/**
 * Fetches and parses a shiprocket.co tracking page.
 * Returns { packagedStatus, deliveredDate } on success (deliveredDate is
 * only set when the status is Delivered AND a date could be read), { notFound: true } if the page
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
  if (!packagedStatus) return { notFound: true };
  return {
    packagedStatus,
    deliveredDate: packagedStatus === 'Delivered' ? extractDeliveredDate(html) : null,
  };
}

module.exports = { fetchTrackingPageStatus, extractDeliveredDate };
