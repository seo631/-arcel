// Reads the actual delivery date out of an order's STORED scan history —
// no network call. Delhivery's scan entries are saved as a compact "D Mon"
// (e.g. "5 Sep") with no year, so the year is inferred from the order
// date (a delivery can't be before the order, or in the future). Entries
// saved by newer syncs also carry a full `iso` date (YYYY-MM-DD), which
// is preferred whenever present.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function makeDate(y, m, d) {
  const date = new Date(y, m, d); // local midnight, same convention as delhiveryService
  return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date : null;
}

// True for a genuine customer-delivery scan; false for undelivered /
// RTO / return-to-origin wording ("out for delivery" has no "delivered").
function isDeliveryLabel(label) {
  return /\bdelivered\b/i.test(label || '') && !/undelivered|not\s+delivered|rto|return|origin/i.test(label);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS_AFTER_ORDER = 180; // a real delivery is days-weeks after the order, never months

// Last line of defence against a wrong date from ANY source (a mis-read
// HTML snippet, a year mix-up): a real delivery is never in the future,
// never before the order was placed, and never absurdly long after it.
// Anything failing this is rejected and the field is left blank instead.
function isPlausibleDeliveryDate(date, orderDate) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const t = date.getTime();
  if (t > Date.now() + DAY_MS) return false;
  if (orderDate) {
    const o = new Date(orderDate).getTime();
    if (!Number.isNaN(o)) {
      if (t < o - DAY_MS) return false;
      if (t > o + MAX_DAYS_AFTER_ORDER * DAY_MS) return false;
    }
  }
  return true;
}

function parseScanDate(entry, orderDate, now) {
  if (entry.iso && /^\d{4}-\d{2}-\d{2}/.test(entry.iso)) {
    const [y, m, d] = entry.iso.slice(0, 10).split('-').map(Number);
    return makeDate(y, m - 1, d);
  }
  const m = String(entry.date || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3})/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  const day = Number(m[1]);
  if (mon === undefined) return null;

  const base = orderDate ? new Date(orderDate) : null;
  const startYear = base && !Number.isNaN(base.getTime()) ? base.getFullYear() : now.getFullYear();
  let date = makeDate(startYear, mon, day);
  if (!date) return null;
  // Earlier than the order (allowing a day of slack) => it's the next year.
  if (base && date.getTime() < base.getTime() - 24 * 60 * 60 * 1000) date = makeDate(startYear + 1, mon, day);
  // Still in the future => can't be a real delivery date.
  if (!date || date.getTime() > now.getTime() + 24 * 60 * 60 * 1000) return null;
  return date;
}

// Newest delivery scan wins. Returns a Date or null.
function deliveryDateFromScanHistory(scanHistory, orderDate) {
  if (!scanHistory || !scanHistory.length) return null;
  const now = new Date();
  for (let i = scanHistory.length - 1; i >= 0; i -= 1) {
    const entry = scanHistory[i];
    if (!entry || !isDeliveryLabel(entry.label)) continue;
    const date = parseScanDate(entry, orderDate, now);
    if (date && isPlausibleDeliveryDate(date, orderDate)) return date;
  }
  return null;
}

module.exports = { deliveryDateFromScanHistory, isPlausibleDeliveryDate };
