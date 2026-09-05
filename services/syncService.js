const Order = require('../models/Order');
const { fetchOrdersSince, resolveDefaultSince, isDelhiveryCourier, SHIPMENT_STATUS_MAP } = require('./shopifyService');
const { fetchByOrderNumber, TERMINAL_STATUSES } = require('./delhiveryService');

const DELAY_MS = 300; // pacing between Delhivery calls, same as your Apps Script

let syncInProgress = false;
let lastSyncSummary = null;
let syncProgress = null; // { checked, total } while a Delhivery check is running

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
  let autoCancelled = 0;

  for (const order of orders) {
    const set = { ...order };
    const needsExisting =
      order.cancelledAt ||
      (order.courier && !isDelhiveryCourier(order.courier)) ||
      (!order.courier && order.shopifyFulfillmentStatus === 'fulfilled');
    let existingStatus;
    if (needsExisting) {
      const existing = await Order.findOne({ shopifyId: order.shopifyId }).select('packagedStatus').lean();
      existingStatus = existing?.packagedStatus;
    }

    // A Shopify-cancelled order will never actually ship, so it would
    // otherwise sit at "Not Yet Shipped" forever and keep getting queued
    // for a Delhivery check that can never find it. Auto-flip it to
    // Cancelled — but ONLY if it hasn't already picked up a real
    // Delhivery status (e.g. In Transit/Delivered), since a cancellation
    // recorded in Shopify after the fact (a return, a refund) shouldn't
    // clobber what actually happened to the physical shipment.
    if (order.cancelledAt) {
      if (!existingStatus || existingStatus === 'Not Yet Shipped') {
        set.packagedStatus = 'Cancelled';
        autoCancelled += 1;
      }
    } else if (order.courier && !isDelhiveryCourier(order.courier)) {
      // Shipped via some OTHER courier partner (not Delhivery) — our
      // Delhivery API polling will never find this order, so Shopify's
      // own fulfillment tracking (shipment_status) is the only source of
      // truth for it, same info shown on the order's page in Shopify.
      const mapped = SHIPMENT_STATUS_MAP[order.shopifyShipmentStatus];
      set.packagedStatus =
        mapped || (existingStatus && existingStatus !== 'Not Yet Shipped' ? existingStatus : 'Dispatched');
      if (set.packagedStatus === 'Delivered') set.deliveredAt = new Date();
    } else if (!order.courier && order.shopifyFulfillmentStatus === 'fulfilled') {
      // Fulfilled in Shopify but with NO courier/tracking attached at
      // all — no AWB to check anywhere, which usually means it was
      // handed to the customer directly (local/hand delivery) rather
      // than shipped. Reflect that instead of leaving it stuck at
      // "Not Yet Shipped" forever. Only applied while it hasn't already
      // picked up a real status some other way.
      if (!existingStatus || existingStatus === 'Not Yet Shipped') {
        set.packagedStatus = 'Hand Delivered';
        set.deliveredAt = new Date();
      }
    }

    const result = await Order.findOneAndUpdate(
      { shopifyId: order.shopifyId },
      { $set: set },
      { upsert: true, new: true, rawResult: true }
    );
    if (result.lastErrorObject?.updatedExisting) updated += 1;
    else created += 1;
  }

  return { totalOrders: orders.length, created, updated, autoCancelled };
}

/**
 * Step 2: check Delhivery for tracking updates.
 *  - No `orderNumbers` given: every order NOT in a terminal status (the
 *    full queue) — matches your Apps Script's rate-limit-safe pacing.
 *  - `orderNumbers` given: ONLY those orders, regardless of their current
 *    status — this is the "check selected rows" path, so it also lets you
 *    force a re-check on an already-Delivered/Cancelled order if you
 *    explicitly picked it.
 * Node isn't bound by Apps Script's 6-minute execution cap, so the full
 * queue runs to completion in one background job instead of needing
 * manual "next 50" batches — but keeps the same per-call delay and
 * 429/403 retry-once behavior. Progress is tracked in `syncProgress` so
 * the UI can show "checked X of Y" instead of an indefinite spinner.
 */
async function syncDelhiveryTracking(orderNumbers) {
  const query = orderNumbers && orderNumbers.length
    ? { orderNumber: { $in: orderNumbers } }
    : {
        packagedStatus: { $nin: TERMINAL_STATUSES },
        // Skip orders shipped via some OTHER courier partner — Delhivery's
        // API will never find them, so querying it is a wasted call every
        // single time. Their status comes from Shopify's own fulfillment
        // tracking instead (see syncShopifyOrders' courier handling).
        $or: [{ courier: { $exists: false } }, { courier: null }, { courier: /delhivery/i }],
      };
  const pending = await Order.find(query).select('_id orderNumber pickupDate packagedStatus trackingNumber shopifyShipmentStatus');

  let checked = 0;
  let updatedCount = 0;
  let notFound = 0;
  let fromShopifyFallback = 0;
  let errors = 0;
  syncProgress = { checked: 0, total: pending.length };

  try {
    for (const order of pending) {
      checked += 1;
      syncProgress.checked = checked;
      // Try Delhivery's ref_id lookup first (our own "NEAT-<orderNumber>"
      // convention). If that misses, also try the real AWB from Shopify's
      // fulfillment tracking — this catches orders booked through an
      // aggregator (e.g. Shiprocket) that still ship on Delhivery's
      // network under Delhivery's own AWB, which our ref_id never matches.
      let result = await fetchByOrderNumber(order.orderNumber, order.trackingNumber);

      if (result.rateLimited) {
        const wait = Math.min(result.retryAfterSeconds, 60);
        await sleep(wait * 1000);
        result = await fetchByOrderNumber(order.orderNumber, order.trackingNumber);
      }

      if (result.error) {
        errors += 1;
        await Order.updateOne({ _id: order._id }, { $set: { syncError: result.error, lastSyncedAt: new Date() } });
        await sleep(DELAY_MS);
        continue;
      }
      if (result.notFound) {
        // Last resort: Shopify's own carrier-reported shipment_status
        // (the same info shown on the order's page in Shopify) — covers
        // shipments Delhivery's public tracking API won't recognize under
        // either lookup, e.g. ones booked entirely through a third party.
        const mapped = SHIPMENT_STATUS_MAP[order.shopifyShipmentStatus];
        if (mapped && mapped !== order.packagedStatus) {
          const set = { packagedStatus: mapped, lastSyncedAt: new Date(), syncError: null };
          if (mapped === 'Delivered') set.deliveredAt = new Date();
          await Order.updateOne({ _id: order._id }, { $set: set });
          fromShopifyFallback += 1;
        } else {
          notFound += 1;
        }
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
  } finally {
    syncProgress = null;
  }

  return { checked, updated: updatedCount, fromShopifyFallback, notFound, errors, remaining: 0 };
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

/**
 * "Update Delivery Status" for just the checked rows in the table —
 * bypasses the terminal-status filter (so it re-checks even a Delivered/
 * Cancelled order you explicitly selected) and skips the rest of the
 * queue entirely, so a handful of orders finishes in seconds instead of
 * waiting behind everything else in the "Not Yet Shipped" queue.
 */
async function runDelhiverySelected(orderNumbers) {
  if (syncInProgress) return { skipped: true, reason: 'A sync is already running' };
  if (!orderNumbers || !orderNumbers.length) return { skipped: true, reason: 'No orders selected' };
  syncInProgress = true;
  const startedAt = new Date();

  try {
    const delhiveryResult = await syncDelhiveryTracking(orderNumbers);

    lastSyncSummary = {
      type: 'delhivery-selected',
      startedAt,
      finishedAt: new Date(),
      ok: true,
      delhivery: delhiveryResult,
    };
  } catch (err) {
    lastSyncSummary = { type: 'delhivery-selected', startedAt, finishedAt: new Date(), ok: false, error: err.message };
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
function getSyncProgress() {
  return syncProgress;
}

module.exports = {
  runSync,
  runShopifySync,
  runDelhiveryTracking,
  runDelhiverySelected,
  getLastSyncSummary,
  isSyncInProgress,
  getSyncProgress,
};
