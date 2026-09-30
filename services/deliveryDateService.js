// Finds an order's ACTUAL delivery date from every real source, in order,
// and never invents one. Each source is either a date read from real data
// or a reason it couldn't help; the date must also pass a plausibility
// check (not future, not before the order, not months after it) or it is
// rejected. If nothing yields a date, the field stays blank and the
// reasons are returned so it's clear why.
//
// Order:  1) stored scan history  2) Delhivery API  3) tracking-link raw
// HTML (other courier partners)  4) Shopify fulfillment events.
const { fetchByOrderNumber } = require('./delhiveryService');
const { fetchTrackingPageStatus } = require('./trackingPageService');
const { deliveryDateFromScanHistory, isPlausibleDeliveryDate } = require('./scanDateService');
const { fetchDeliveredDateFromShopify } = require('./shopifyService');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Delhivery lookup with retry-once-on-429, shared with the sync loop.
async function apiLookup(order) {
  let r = await fetchByOrderNumber(order.orderNumber, order.trackingNumber);
  if (r.rateLimited) {
    await sleep(Math.min(r.retryAfterSeconds, 60) * 1000);
    r = await fetchByOrderNumber(order.orderNumber, order.trackingNumber);
  }
  return r;
}

/**
 * @param order  needs: orderNumber, orderDate, scanHistory, trackingNumber,
 *               trackingUrl, shopifyId
 * @param known  results already fetched this round, to avoid repeat calls:
 *               { api } (Delhivery result) and/or { page } (tracking link
 *               result, null when the order has no link)
 * @returns { date, source } | { date: null, reasons: [...] }
 */
async function findActualDeliveryDate(order, known = {}) {
  const reasons = [];
  const ok = (d) => isPlausibleDeliveryDate(d, order.orderDate);

  // 1) Scan history already stored (prefer the fresh one from this round's
  //    API call, which also carries full dates).
  const history = (known.api && known.api.scanHistory) || order.scanHistory;
  const fromScans = deliveryDateFromScanHistory(history, order.orderDate);
  if (fromScans) return { date: fromScans, source: 'scan history' };
  reasons.push(history && history.length ? 'scan history has no Delivered scan' : 'no scan history stored');

  // 2) Delhivery API.
  const api = known.api || (await apiLookup(order));
  if (api.error) reasons.push(`Delhivery API error: ${api.error}`);
  else if (api.notFound) reasons.push('Delhivery has no record of this order/AWB');
  else if (api.packagedStatus !== 'Delivered') reasons.push(`Delhivery shows "${api.packagedStatus}", not Delivered`);
  else if (!api.actualDeliveryDate) reasons.push('Delhivery says Delivered but returned no delivery date');
  else if (!ok(api.actualDeliveryDate)) reasons.push('Delhivery date rejected (outside a plausible range)');
  else return { date: api.actualDeliveryDate, source: 'Delhivery API' };

  // 3) Tracking link — raw HTML (Shiprocket / other partners).
  const page = known.page !== undefined ? known.page : await fetchTrackingPageStatus(order.trackingUrl);
  if (!order.trackingUrl) reasons.push('no tracking link saved');
  else if (!page) reasons.push('tracking link is not a valid URL');
  else if (page.error) reasons.push(`tracking link: ${page.error}`);
  else if (page.notFound) reasons.push(`tracking link: ${page.reason || 'no status found'}`);
  else if (page.packagedStatus !== 'Delivered') reasons.push(`tracking link shows "${page.packagedStatus}", not Delivered`);
  else if (!page.deliveredDate) reasons.push('tracking link says Delivered but no date could be read from its HTML');
  else if (!ok(page.deliveredDate)) reasons.push('tracking-link date rejected (outside a plausible range)');
  else return { date: page.deliveredDate, source: 'tracking link' };

  // 4) Shopify's own fulfillment events (the timeline on the order page).
  if (order.shopifyId) {
    const sh = await fetchDeliveredDateFromShopify(order.shopifyId);
    if (sh.date && ok(sh.date)) return { date: sh.date, source: 'Shopify' };
    reasons.push(sh.date ? 'Shopify date rejected (outside a plausible range)' : sh.reason);
  } else {
    reasons.push('not a Shopify-synced order (no Shopify id)');
  }

  return { date: null, reasons };
}

module.exports = { findActualDeliveryDate, apiLookup };
