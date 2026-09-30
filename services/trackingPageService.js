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
  //    or an epoch value like "delivered_at":1757059200.
  const keyRe = /["'](?:delivered_date|delivery_date|delivered_at|deliveredDate|deliveredOn|delivered_on|deliveredAt|delivery_datetime|actual_delivery_date|actualDeliveryDate)["']\s*:\s*(?:["']([^"']+)["']|(\d{10,13}))/gi;
  let km;
  while ((km = keyRe.exec(html))) {
    if (km[2]) {
      const ms = km[2].length === 10 ? Number(km[2]) * 1000 : Number(km[2]);
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime()) && d.getFullYear() >= 2020 && d <= new Date()) {
        return makeDate(d.getFullYear(), d.getMonth(), d.getDate());
      }
      continue;
    }
    const dates = findDates(km[1]);
    if (dates.length) return dates[0].date;
  }

  // 2a) Structured pass over the raw HTML: take the tightest entry that
  //     contains a genuine "Delivered" — the enclosing JSON object or
  //     <li>/<tr> row, cut off at the first nested child — and read the
  //     date inside it. This is what stops a "current_status":"Delivered"
  //     header from being paired with the previous event's date.
  //     \bdelivered\b already excludes "Undelivered"; RTO/return/origin
  //     phrasing is skipped so a returned parcel's "delivered to origin"
  //     isn't mistaken for the customer delivery.
  const isReturnContext = (str, idx) =>
    /rto|return|origin/i.test(str.slice(Math.max(0, idx - 12), idx)) || /origin/i.test(str.slice(idx, idx + 24));
  const openers = ['{', '<li', '<tr', '['];
  const closers = ['}', '</li>', '</tr>', '{', '<li', '<tr', ']'];
  const wordRe = /\bdelivered\b/gi;
  let wm;
  while ((wm = wordRe.exec(html))) {
    if (isReturnContext(html, wm.index)) continue;
    const start = Math.max(...openers.map((o) => html.lastIndexOf(o, wm.index)));
    const ends = closers.map((c) => html.indexOf(c, wm.index + 1)).filter((i) => i > -1);
    const end = ends.length ? Math.min(...ends) : wm.index + 300;
    const segment = html.slice(Math.max(start, wm.index - 300), Math.min(end + 1, wm.index + 300));
    const dates = findDates(segment);
    if (dates.length) {
      const anchor = wm.index - Math.max(start, wm.index - 300);
      dates.sort((x, y) => Math.abs(x.index - anchor) - Math.abs(y.index - anchor));
      return dates[0].date;
    }
  }

  // 2b) Fallback for markup with no rows/objects (plain divs): nearest
  //     date to a "Delivered" in the visible text, activity log first.
  const text = htmlToText(html);
  const actIdx = text.search(/Activity\s*:?/i);
  const scopes = actIdx === -1 ? [text] : [text.slice(actIdx), text];
  for (const scope of scopes) {
    const re = /\bdelivered\b/gi;
    let tm;
    while ((tm = re.exec(scope))) {
      if (isReturnContext(scope, tm.index)) continue;
      const from = Math.max(0, tm.index - 120);
      const dates = findDates(scope.slice(from, tm.index + 160));
      if (!dates.length) continue;
      const anchor = tm.index - from;
      dates.sort((x, y) => Math.abs(x.index - anchor) - Math.abs(y.index - anchor));
      return dates[0].date;
    }
  }
  return null;
}

// ---------- Generic (non-Shiprocket) tracking pages ----------
// Other partners' pages have unknown markup, so the only thing trusted
// from them is an explicit "Delivered" — never any other status — which
// keeps a wrongly-parsed page from overwriting a good status. JSON status
// fields first (most modern trackers embed their state as JSON), then the
// visible "Status: ..." label, then plain "has been delivered" wording.
function genericDeliveredCheck(html) {
  const jsonRe = /["'](?:current_status|currentStatus|shipment_status|shipmentStatus|delivery_status|deliveryStatus|tracking_status|trackingStatus|status_text|statusText|latest_status|latestStatus)["']\s*:\s*["']([^"']{2,60})["']/gi;
  let m;
  let seen = null;
  while ((m = jsonRe.exec(html))) {
    const mapped = mapStatusBlock(m[1]);
    if (mapped) {
      seen = m[1];
      if (mapped === 'Delivered') return { delivered: true, evidence: `json status "${m[1]}"` };
      break;
    }
  }
  if (seen) return { delivered: false, evidence: `json status "${seen}"` };

  const text = htmlToText(html);
  const label = text.match(/(?:current\s+|shipment\s+|order\s+|delivery\s+)?status\s*[:\-]?\s*([A-Za-z][A-Za-z ]{2,30})/i);
  if (label) {
    const mapped = mapStatusBlock(label[1]);
    if (mapped) {
      return mapped === 'Delivered'
        ? { delivered: true, evidence: `status label "${label[1].trim()}"` }
        : { delivered: false, evidence: `status label "${label[1].trim()}"` };
    }
  }
  if (/(?:has\s+been|was|successfully|is)\s+delivered(?!\s+to\s+origin)/i.test(text) && !/rto|return(?:ed)?\s+to/i.test(text.slice(0, 2000))) {
    return { delivered: true, evidence: 'text says "delivered"' };
  }
  return { delivered: false, evidence: null };
}

function parseTrackingHtml(html, isShiprocket) {
  if (isShiprocket) {
    const block = isolateCurrentStatusBlock(html);
    const packagedStatus = mapStatusBlock(block);
    if (!packagedStatus) return { notFound: true, reason: 'Shiprocket page loaded but no recognisable status found' };
    return {
      packagedStatus,
      deliveredDate: packagedStatus === 'Delivered' ? extractDeliveredDate(html) : null,
    };
  }
  const check = genericDeliveredCheck(html);
  if (check.delivered) {
    return { packagedStatus: 'Delivered', deliveredDate: extractDeliveredDate(html), evidence: check.evidence };
  }
  return {
    notFound: true,
    reason: check.evidence
      ? `link shows ${check.evidence}, not delivered`
      : `no status found in the raw HTML (${html.length} bytes) — the page is probably rendered by JavaScript`,
  };
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
};

// Raw fetch, shared by the sync and the debug endpoint/script.
async function fetchRawPage(url) {
  let res;
  try {
    res = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(d) => d],
      headers: BROWSER_HEADERS,
    });
  } catch (err) {
    return { error: err.message };
  }
  const finalUrl = res.request?.res?.responseUrl || url;
  return { httpStatus: res.status, html: String(res.data ?? ''), finalUrl };
}

/**
 * Fetches a tracking link's raw HTML and reads the status + delivered date.
 *  - shiprocket.co links: full status parsing (as before).
 *  - any other http(s) link: only an explicit "Delivered" is trusted.
 * Returns { packagedStatus, deliveredDate? } when a status was read,
 * { notFound: true, reason } when the page loaded but nothing usable was
 * found, { error } on a network/HTTP failure, or null if there is no
 * usable link at all.
 */
async function fetchTrackingPageStatus(url) {
  if (!url || !/^https?:\/\//i.test(String(url).trim())) return null;
  const link = String(url).trim();
  const page = await fetchRawPage(link);
  if (page.error) return { error: page.error };
  if (page.httpStatus !== 200) return { error: `HTTP ${page.httpStatus}` };
  return parseTrackingHtml(page.html, /shiprocket\.co\/tracking\//i.test(link));
}

module.exports = { fetchTrackingPageStatus, fetchRawPage, parseTrackingHtml, extractDeliveredDate };
