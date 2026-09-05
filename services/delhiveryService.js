const axios = require('axios');

const ORDER_ID_PREFIX = process.env.DELHIVERY_ORDER_ID_PREFIX || 'NEAT-';
const TERMINAL_STATUSES = ['Delivered', 'RTO Delivered', 'Cancelled'];

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
        const date = formatScanDate(detail.ScanDateTime || detail.StatusDateTime);
        const label = detail.Scan || detail.Instructions || detail.ScanType || '';
        return date && label ? { date, label } : null;
      })
      .filter(Boolean);

    // Collapse consecutive duplicate labels, same as your script.
    raw.forEach((e) => {
      const prev = scanHistory[scanHistory.length - 1];
      if (!prev || prev.label !== e.label) scanHistory.push(e);
      else prev.date = e.date;
    });
  }

  return {
    pickupDate: toDDMMYYYY(shipment.PickUpDate),
    // PromisedDeliveryDate first (Delhivery's committed SLA date), then
    // ExpectedDeliveryDate as the fallback live ETA — matches your script.
    estimatedDeliveryDate: toDDMMYYYY(shipment.PromisedDeliveryDate || shipment.ExpectedDeliveryDate),
    packagedStatus: status.Status || 'Unknown',
    ndrReason: status.Status && status.Status !== 'Delivered' ? status.Instructions : null,
    scanHistory,
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
