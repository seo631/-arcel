const Order = require('../models/Order');
const { fetchOrdersSince, resolveDefaultSince } = require('./shopifyService');
const { fetchByOrderNumber, TERMINAL_STATUSES } = require('./delhiveryService');

const DELAY_MS = 300; // pacing between Delhivery calls, same as your Apps Script

let syncInProgress = false;
let lastSyncSummary = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Step 1: pull Shopify orders in the given date range and upsert them.
 * Doesn't touch Delhivery fields on existing rows.
 */
async function syncShopifyOrders(sinceISO, untilISO) {
  const orders = await fetchOrdersSince(sinceISO, untilISO);
  let created = 0;
  let updated = 0;

  for (const order of orders) {
    const result = await Order.findOneAndUpdate(
      { shopifyId: order.shopifyId },
      { $set: order },
      { upsert: true, new: true, rawResult: true }
    );
    if (result.lastErrorObject?.updatedExisting) updated += 1;
    else created += 1;
  }

  return { totalOrders: orders.length, created, updated };
}

/**
 * Step 2: for every order NOT in a terminal status, look it up at
 * Delhivery one at a time (matching your Apps Script's rate-limit-safe
 * pacing) and update tracking fields. Node isn't bound by Apps Script's
 * 6-minute execution cap, so this runs the full queue in one background
 * job instead of needing manual "next 50" batches — but keeps the same
 * per-call delay and 429/403 retry-once behavior.
 */
async function syncDelhiveryTracking() {
  const pending = await Order.find({
    packagedStatus: { $nin: TERMINAL_STATUSES },
  }).select('_id orderNumber pickupDate packagedStatus');

  let checked = 0;
  let updatedCount = 0;
  let notFound = 0;
  let errors = 0;

  for (const order of pending) {
    checked += 1;
    let result = await fetchByOrderNumber(order.orderNumber);

    if (result.rateLimited) {
      const wait = Math.min(result.retryAfterSeconds, 60);
      await sleep(wait * 1000);
      result = await fetchByOrderNumber(order.orderNumber);
    }

    if (result.error) {
      errors += 1;
      await Order.updateOne({ _id: order._id }, { $set: { syncError: result.error, lastSyncedAt: new Date() } });
      await sleep(DELAY_MS);
      continue;
    }
    if (result.notFound) {
      notFound += 1;
      await sleep(DELAY_MS);
      continue;
    }

    const set = {
      refId: result.refId,
      packagedStatus: result.packagedStatus,
      scanHistory: result.scanHistory,
      ndrReason: result.ndrReason,
      lastSyncedAt: new Date(),
      syncError: null,
    };
    if (result.estimatedDeliveryDate) set.estimatedDeliveryDate = result.estimatedDeliveryDate;
    if (result.packagedStatus === 'Delivered') set.deliveredAt = result.estimatedDeliveryDate || new Date();

    // Pickup date: write-once, never overwritten once set — same as your script.
    if (!order.pickupDate && result.pickupDate) set.pickupDate = result.pickupDate;

    await Order.updateOne({ _id: order._id }, { $set: set });
    updatedCount += 1;
    await sleep(DELAY_MS);
  }

  return { checked, updated: updatedCount, notFound, errors, remaining: 0 };
}

async function runSync({ since, until } = {}) {
  if (syncInProgress) return { skipped: true, reason: 'A sync is already running' };
  syncInProgress = true;
  const startedAt = new Date();

  try {
    const sinceISO = since || resolveDefaultSince();
    const shopifyResult = await syncShopifyOrders(sinceISO, until);
    const delhiveryResult = await syncDelhiveryTracking();

    lastSyncSummary = {
      type: 'full',
      startedAt,
      finishedAt: new Date(),
      ok: true,
      range: { since: sinceISO, until: until || null },
      shopify: shopifyResult,
      delhivery: delhiveryResult,
    };
  } catch (err) {
    lastSyncSummary = { type: 'full', startedAt, finishedAt: new Date(), ok: false, error: err.message };
    throw err;
  } finally {
    syncInProgress = false;
  }

  return lastSyncSummary;
}

/**
 * "Sync" button: pull orders FROM Shopify only. Never touches Delhivery —
 * existing tracking/status fields on orders are left exactly as they are.
 */
async function runShopifySync({ since, until } = {}) {
  if (syncInProgress) return { skipped: true, reason: 'A sync is already running' };
  syncInProgress = true;
  const startedAt = new Date();

  try {
    const sinceISO = since || resolveDefaultSince();
    const shopifyResult = await syncShopifyOrders(sinceISO, until);

    lastSyncSummary = {
      type: 'shopify',
      startedAt,
      finishedAt: new Date(),
      ok: true,
      range: { since: sinceISO, until: until || null },
      shopify: shopifyResult,
    };
  } catch (err) {
    lastSyncSummary = { type: 'shopify', startedAt, finishedAt: new Date(), ok: false, error: err.message };
    throw err;
  } finally {
    syncInProgress = false;
  }

  return lastSyncSummary;
}

/**
 * "Update Delivery Status" button: check LIVE status at Delhivery for
 * every order not already in a terminal state, and update packagedStatus/
 * scanHistory/etc. Never touches Shopify — no new orders are pulled in.
 */
async function runDelhiveryTracking() {
  if (syncInProgress) return { skipped: true, reason: 'A sync is already running' };
  syncInProgress = true;
  const startedAt = new Date();

  try {
    const delhiveryResult = await syncDelhiveryTracking();

    lastSyncSummary = {
      type: 'delhivery',
      startedAt,
      finishedAt: new Date(),
      ok: true,
      delhivery: delhiveryResult,
    };
  } catch (err) {
    lastSyncSummary = { type: 'delhivery', startedAt, finishedAt: new Date(), ok: false, error: err.message };
    throw err;
  } finally {
    syncInProgress = false;
  }

  return lastSyncSummary;
}

function getLastSyncSummary() {
  return lastSyncSummary;
}
function isSyncInProgress() {
  return syncInProgress;
}

module.exports = {
  runSync,
  runShopifySync,
  runDelhiveryTracking,
  getLastSyncSummary,
  isSyncInProgress,
};
