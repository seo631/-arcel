const axios = require('axios');

const ORDER_ID_PREFIX = process.env.DELHIVERY_ORDER_ID_PREFIX || 'NEAT-';

// "Terminal" here means "resolved enough that a lower-priority source
// (Shopify's own shipment_status guess) shouldn't be allowed to clobber
// it" — see syncShopifyOrders. It does NOT mean "never worth checking
// again". In particular 'Delivered' is NOT permanently final: customers
// return items after delivery all the time, and that shows up as a
// fresh RTO leg on the same AWB. syncService's auto-check queue treats
// 'Delivered' as re-checkable for a window after deliveredAt
// (DELIVERED_RECHECK_DAYS) instead of excluding it forever the moment
// it's set — only 'RTO', 'Cancelled', and 'Hand Delivered' are truly
// final (no further leg is ever expected on those AWBs).
//
// 'RTO' is the single label for "the return is complete" — Delhivery's
// own public tracking page uses the plain word "Returned" for this,
// not "RTO Delivered", so a completed return shows here as one flat
// status rather than a half-generic "RTO In Transit" that undersells
// how resolved it actually is.
const TERMINAL_STATUSES = ['Delivered', 'RTO', 'Cancelled', 'Hand Delivered'];

function baseURL() {
  return process.env.DELHIVERY_BASE_URL || 'https://track.delhivery.com';
}

function toDDMMYYYY(value) {
  if (!value) return null;
  const datePart = String(value).split(/[ T]/)[0];
  const parts = datePart.split('-');
  if (parts.length !== 3) return null;
  const [yyyy, mm, dd] = parts;
  return new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
}

function formatScanDate(value) {
  if (!value) return '';
  const datePart = String(value).split(/[ T]/)[0];
  const parts = datePart.split('-');
  if (parts.length !== 3) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = Number(parts[1]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return '';
  return `${Number(parts[2])} ${months[monthIndex]}`;
}

// Delhivery's coarse `Status.Status` string (e.g. "In Transit") is
// ambiguous — it's used for BOTH a shipment moving toward the customer
// AND one moving back to origin as an RTO/return. The only reliable
// signal for "this is actually in the return leg" is `Status.StatusType`
// — Delhivery sends 'RT' for anything moving in the return direction,
// regardless of what the plain-English Status string says. Without
// checking StatusType, an "out for return"/RTO-in-progress shipment
// looks identical to a normal forward "In Transit" one.
function mapDelhiveryStatus(status) {
  const raw = (status.Status || '').trim();
  const type = (status.StatusType || '').trim().toUpperCase();
  const instructions = (status.Instructions || '').toLowerCase();

  if (type === 'RT') {
    if (
      raw === 'Delivered' ||
      /\breturned\b/.test(raw.toLowerCase()) ||
      instructions.includes('rto delivered') ||
      instructions.includes('delivered to origin') ||
      instructions.includes('returned') ||
      // Delhivery also phrases a completed return as "Shipment return
      // accepted" (confirmed live on order 17049/AWB 45819210024080,
      // Sep 2026) — this is the warehouse accepting the returned parcel
      // back, i.e. the return IS complete, not still in progress. Without
      // this, orders phrased this way got stuck on the vaguer
      // "RTO In Transit" forever, since neither this check nor the
      // scan-history fallback below recognized the phrase.
      instructions.includes('return accepted')
    ) {
      return 'RTO';
    }
    if (instructions.includes('initiat')) return 'RTO Initiated';
    return 'RTO In Transit'; // covers "out for return", "in transit" (return leg), etc.
  }

  if (type === 'DL') return 'Delivered';
  if (type === 'CN') return 'Cancelled';
  if (type === 'LT') return 'Lost';
  if (type === 'PP') return 'Manifested'; // pickup pending

  const known = [
    'Pending', 'Manifested', 'Dispatched', 'In Transit', 'Delivered',
    'RTO Initiated', 'RTO In Transit', 'RTO', 'Cancelled', 'Lost',
  ];
  return known.includes(raw) ? raw : (raw || 'Unknown');
}

// If the coarse Status/StatusType fields haven't caught up yet, the most
// recent entry in the SAME response's scan history can already show an
// RTO scan — this is exactly what happened on a real order: the API's
// top-level status still said "Delivered" days after its own scan log
// had already recorded an RTO event. Checked most-specific first, mirrors
// trackingPageService's page-scrape keywords. This only ever pulls a
// status TOWARD RTO (never away from it), so it can't override a
// correctly-detected non-RTO status — it only catches this one lag
// pattern. "returned" is checked before the bare "rto" fallback so a
// completed return (Delhivery's own wording: "Returned") lands on the
// single flat 'RTO' status instead of the vaguer 'RTO In Transit'.
const SCAN_RTO_KEYWORDS = [
  { re: /rto\s*delivered/i, status: 'RTO' },
  { re: /\breturned\b/i, status: 'RTO' },
  { re: /return\s*accepted/i, status: 'RTO' }, // "Shipment return accepted" — warehouse received the return; complete, not in-progress
  { re: /rto\s*initiat/i, status: 'RTO Initiated' },
  { re: /\brto\b/i, status: 'RTO In Transit' },
];

// Returns { status, scanDate } — scanDate (a real Date, from the raw scan
// timestamp, not the display-formatted "D Mon" string) is set only when
// this function is what identified the RTO, so callers can stamp
// returnedAt with the actual event date instead of "whenever we happened
// to sync".
function inferStatusFromLatestScan(scanHistory, apiStatus) {
  if (!scanHistory || !scanHistory.length) return { status: apiStatus, scanDate: null };
  const latest = scanHistory[scanHistory.length - 1]; // oldest-first array, so last = most recent
  if (!latest || !latest.label) return { status: apiStatus, scanDate: null };
  for (const { re, status } of SCAN_RTO_KEYWORDS) {
    if (re.test(latest.label)) return { status, scanDate: toDDMMYYYY(latest.rawDate) };
  }
  return { status: apiStatus, scanDate: null };
}

// Real delivery date for a shipment that Delhivery reports as Delivered.
// Sources, most direct first: the shipment's own DeliveryDate field, the
// status timestamp when the status type is DL, then the newest scan that
// says "Delivered" (excluding undelivered / RTO / return wording).
// Returns null if none of them yield a date — callers must NOT invent one.
function extractDeliveredDate(shipment, status, scanHistory) {
  const direct = toDDMMYYYY(shipment.DeliveryDate);
  if (direct && !Number.isNaN(direct.getTime())) return direct;

  if ((status.StatusType || '').trim().toUpperCase() === 'DL') {
    const fromStatus = toDDMMYYYY(status.StatusDateTime);
    if (fromStatus && !Number.isNaN(fromStatus.getTime())) return fromStatus;
  }

  for (let i = scanHistory.length - 1; i >= 0; i -= 1) {
    const { label, rawDate } = scanHistory[i];
    if (/\bdelivered\b/i.test(label) && !/undelivered|not\s+delivered|rto|return/i.test(label)) {
      const d = toDDMMYYYY(rawDate);
      if (d && !Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

/**
 * Runs one Delhivery packages/json lookup with the given query params
 * (either `{ ref_ids }` or `{ waybill }`) and normalizes the response.
 * Shared by ref-id and waybill lookups below.
 */
async function queryDelhivery(extraParams) {
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) throw new Error('DELHIVERY_API_TOKEN missing in .env');

  const url = `${baseURL()}/api/v1/packages/json/`;

  let res;
  try {
    res = await axios.get(url, {
      params: { ...extraParams, token },
      timeout: 20000,
      validateStatus: () => true, // handle non-200 ourselves, same as muteHttpExceptions
    });
  } catch (err) {
    return { error: err.message };
  }

  if (res.status === 429 || res.status === 403) {
    const retryAfterRaw = res.headers['retry-after'];
    return {
      rateLimited: true,
      retryAfterSeconds: retryAfterRaw ? Number(retryAfterRaw) : 30,
      error: `Blocked (HTTP ${res.status})`,
    };
  }
  if (res.status !== 200) return { error: `HTTP ${res.status}` };

  const shipmentData = res.data?.ShipmentData;
  if (!shipmentData || shipmentData.length === 0) return { notFound: true };

  const shipment = shipmentData[0].Shipment;
  const status = shipment.Status || {};

  let scanHistory = [];
  const scans = shipment.Scans;
  if (scans && scans.length) {
    const raw = scans
      .map((s) => {
        const detail = s.ScanDetail || s;
        const rawDate = detail.ScanDateTime || detail.StatusDateTime;
        const date = formatScanDate(rawDate);
        // Delhivery's `Scan` field is often a terse code (e.g. bare "RTO")
        // while `Instructions` carries the actual human-readable detail
        // (e.g. "Shipment return accepted") that the keyword matching
        // above depends on. Combine both when they differ so no detail is
        // lost — this fixed a real case where "RTO" alone only matched
        // the vague generic keyword while the informative "return
        // accepted" text sat unused in Instructions the whole time.
        const scan = detail.Scan || '';
        const instr = detail.Instructions || '';
        const label = scan && instr && scan.trim().toLowerCase() !== instr.trim().toLowerCase()
          ? `${scan} - ${instr}`
          : (scan || instr || detail.ScanType || '');
        return date && label ? { date, label, rawDate } : null;
      })
      .filter(Boolean);

    // Collapse consecutive duplicate labels, same as your script.
    raw.forEach((e) => {
      const prev = scanHistory[scanHistory.length - 1];
      if (!prev || prev.label !== e.label) scanHistory.push(e);
      else {
        prev.date = e.date;
        prev.rawDate = e.rawDate;
      }
    });
  }

  const apiStatus = mapDelhiveryStatus(status);
  const { status: packagedStatus, scanDate } = inferStatusFromLatestScan(scanHistory, apiStatus);

  return {
    pickupDate: toDDMMYYYY(shipment.PickUpDate),
    // PromisedDeliveryDate first (Delhivery's committed SLA date), then
    // ExpectedDeliveryDate as the fallback live ETA — matches your script.
    estimatedDeliveryDate: toDDMMYYYY(shipment.PromisedDeliveryDate || shipment.ExpectedDeliveryDate),
    packagedStatus,
    // Only meaningful (and only looked up) when the final status is
    // Delivered — an RTO/in-transit shipment has no delivery date.
    actualDeliveryDate: packagedStatus === 'Delivered' ? extractDeliveredDate(shipment, status, scanHistory) : null,
    // The actual return-scan date when the scan history told us so;
    // callers fall back to "now" otherwise. Only meaningful when
    // packagedStatus is 'RTO'.
    returnedScanDate: packagedStatus === 'RTO' ? scanDate : null,
    ndrReason: status.Status && status.Status !== 'Delivered' ? status.Instructions : null,
    scanHistory: scanHistory.map(({ date, label }) => ({ date, label })), // drop rawDate — not part of the schema
  };
}

/**
 * One order per call, exactly like your Apps Script — Delhivery's
 * ref_ids lookup first (our own "NEAT-<orderNumber>" convention, for
 * orders booked directly with Delhivery). If that comes back not-found
 * AND we have a real AWB from Shopify's fulfillment tracking (`waybill`
 * — e.g. an order routed through Shiprocket that still ends up on
 * Delhivery's network under Delhivery's own AWB, not our ref_id), retry
 * by that AWB directly before giving up. Returns a normalized result, or
 * { error }, { notFound: true }, or { rateLimited, retryAfterSeconds }.
 */
async function fetchByOrderNumber(orderNumber, waybill) {
  const refId = ORDER_ID_PREFIX + orderNumber;
  const byRef = await queryDelhivery({ ref_ids: refId });
  if (!byRef.notFound) return { ...byRef, refId, lookupMethod: 'ref_id' };

  if (waybill) {
    const byWaybill = await queryDelhivery({ waybill });
    if (!byWaybill.notFound) return { ...byWaybill, refId: waybill, lookupMethod: 'waybill' };
  }

  return byRef; // still { notFound: true } (or the ref_id lookup's error)
}

module.exports = { fetchByOrderNumber, TERMINAL_STATUSES };
