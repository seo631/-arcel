const Order = require('../models/Order');
const { fetchOrdersSince, resolveDefaultSince, isDelhiveryCourier, SHIPMENT_STATUS_MAP } = require('./shopifyService');
const { fetchByOrderNumber, TERMINAL_STATUSES } = require('./delhiveryService');
const { fetchTrackingPageStatus } = require('./trackingPageService');

const DELAY_MS = 300; // pacing between Delhivery calls, same as your Apps Script

// How long after delivery a 'Delivered' order stays in the auto-check
// queue, to catch a customer return that shows up as a fresh RTO leg on
// the same AWB. After this many days without a status change, we stop
// checking it (treat it as genuinely final) rather than polling forever.
const DELIVERED_RECHECK_DAYS = Number(process.env.DELIVERED_RECHECK_DAYS || 15);

// Stamps deliveredAt for the recheck-window logic above. Write-once —
// re-stamping it to "now" on every recheck that still finds 'Delivered'
// would keep pushing the window forward forever and defeat the point of
// having one. Prefers Delhivery's own estimated/promised delivery date
// (fallback) over "now" when available, same as before this rewrite.
function deliveredAtStamp(newStatus, order, fallback) {
  if (newStatus === 'Delivered' && !order.deliveredAt) return fallback || new Date();
  return undefined;
}

// Stamps returnedAt when a shipment reaches the terminal 'RTO' status
// (Delhivery's own wording: "Returned"). Prefers the actual return-scan
// date from Delhivery's scan history over "now", so the dashboard's
// "Returned On" column reflects when the return really happened rather
// than whenever we happened to sync. Write-once, though 'RTO' is
// permanently terminal anyway so this would never re-fire regardless.
function returnedAtStamp(newStatus, order, scanDate) {
  if (newStatus === 'RTO' && !order.returnedAt) return scanDate || new Date();
  return undefined;
}

// Delivered orders that still have no actualDeliveryDate stay in the
// auto-check queue this many days (counted from deliveredAt) so the date
// gets filled in, without polling old undated orders forever. For older
// history run `npm run backfill:delivery-date` once.
const DELIVERY_DATE_BACKFILL_DAYS = Number(process.env.DELIVERY_DATE_BACKFILL_DAYS || 60);

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
      (!order.courier && (order.shopifyFulfillmentStatus === 'fulfilled' || order.shopifyShipmentStatus === 'delivered'));
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
      // Shipped via some OTHER courier partner per Shopify's label —
      // Shopify's own fulfillment tracking (shipment_status) is a
      // reasonable status source for these. But don't let it clobber an
      // already-resolved terminal status (e.g. a real "RTO"
      // confirmed directly against Delhivery by AWB — see
      // syncDelhiveryTracking, which checks these regardless of the
      // courier label since aggregators often route through Delhivery
      // under the hood) with a stale or absent Shopify guess.
      if (!existingStatus || !TERMINAL_STATUSES.includes(existingStatus)) {
        const mapped = SHIPMENT_STATUS_MAP[order.shopifyShipmentStatus];
        set.packagedStatus =
          mapped || (existingStatus && existingStatus !== 'Not Yet Shipped' ? existingStatus : 'Dispatched');
        if (set.packagedStatus === 'Delivered') set.deliveredAt = new Date();
      }
    } else if (!order.courier && (order.shopifyFulfillmentStatus === 'fulfilled' || order.shopifyShipmentStatus === 'delivered')) {
      // No courier/tracking attached AT ALL — nothing to look up anywhere
      // (Delhivery or otherwise) — but Shopify itself shows it as
      // fulfilled/delivered. This is the "handed to the customer
      // directly, no AWB, order page just says Delivered" case. Reflect
      // that instead of leaving it stuck at "Not Yet Shipped" forever.
      // Only applied while it hasn't already picked up a real status
      // some other way.
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
  const recheckCutoff = new Date(Date.now() - DELIVERED_RECHECK_DAYS * 24 * 60 * 60 * 1000);
  const backfillCutoff = new Date(Date.now() - DELIVERY_DATE_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  const query = orderNumbers && orderNumbers.length
    ? { orderNumber: { $in: orderNumbers } }
    : {
        $and: [
          {
            // Anything not in TERMINAL_STATUSES is checked as usual. A
            // 'Delivered' order is ALSO kept in the queue (instead of
            // being excluded forever) as long as it's within
            // DELIVERED_RECHECK_DAYS of its deliveredAt — long enough to
            // catch a post-delivery customer return (a fresh RTO leg on
            // the same AWB), short enough not to poll every ever-delivered
            // order indefinitely. 'RTO'/'Cancelled'/'Hand
            // Delivered' stay excluded permanently — no further leg is
            // ever expected on those UNLESS the order was also cancelled
            // in Shopify (see below).
            //
            // A Shopify cancellation is a standing signal that the stored
            // packagedStatus might be wrong: real case — order 16333 sat
            // at 'Delivered' (terminal, and past the recheck window) for
            // weeks while its own Delhivery scan history showed it never
            // reached the customer at all and had actually gone RTO. The
            // normal terminal/age filter above would skip it forever.
            // cancelledAt overrides that entirely and keeps the order in
            // the queue permanently, regardless of packagedStatus or age
            // — deliberately unbounded (no time window) per your call,
            // since a cancelled order's true delivery outcome is worth
            // confirming for as long as the record exists.
            $or: [
              { packagedStatus: { $nin: TERMINAL_STATUSES } },
              {
                packagedStatus: 'Delivered',
                // Matches both "never stamped yet" and "stamped recently".
                $or: [{ deliveredAt: null }, { deliveredAt: { $gte: recheckCutoff } }],
              },
              { cancelledAt: { $exists: true, $ne: null } },
              {
                // Delivered but the real delivery date was never read.
                packagedStatus: 'Delivered',
                actualDeliveryDate: null,
                deliveredAt: { $gte: backfillCutoff },
              },
            ],
          },
          {
            // Only truly skip an order if there's NOTHING to check it by —
            // no ref_id will ever match (that's tried unconditionally below
            // anyway) AND no real AWB from Shopify either. A courier label
            // of "Shiprocket" etc. does NOT mean skip: aggregators like
            // Shiprocket route through an actual last-mile carrier (often
            // Delhivery) under the hood, so the AWB itself is frequently a
            // genuine, directly-queryable Delhivery shipment even though
            // Shopify's tracking_company field says something else. Trusting
            // that label instead of checking the real AWB is exactly how a
            // stale/wrong status (e.g. "Lost") never gets corrected.
            $or: [
              { courier: { $exists: false } },
              { courier: null },
              { courier: /delhivery/i },
              { trackingNumber: { $exists: true, $nin: [null, ''] } },
              { trackingUrl: { $exists: true, $nin: [null, ''] } },
            ],
          },
        ],
      };
  const pending = await Order.find(query).select('_id orderNumber pickupDate packagedStatus deliveredAt actualDeliveryDate returnedAt trackingNumber trackingUrl shopifyShipmentStatus');

  let checked = 0;
  let updatedCount = 0;
  let notFound = 0;
  let fromTrackingPage = 0;
  let fromShopifyFallback = 0;
  let errors = 0;
  let datesFilled = 0;
  const dateIssues = []; // Delivered orders whose real delivery date still couldn't be found
  syncProgress = { checked: 0, total: pending.length };

  const noteIssue = (order, reason) => {
    if (dateIssues.length < 25) dateIssues.push({ orderNumber: order.orderNumber, reason });
  };

  // Delhivery API lookup with the same retry-once-on-429 behaviour.
  const apiLookup = async (order) => {
    let r = await fetchByOrderNumber(order.orderNumber, order.trackingNumber);
    if (r.rateLimited) {
      await sleep(Math.min(r.retryAfterSeconds, 60) * 1000);
      r = await fetchByOrderNumber(order.orderNumber, order.trackingNumber);
    }
    return r;
  };

  try {
    for (const order of pending) {
      checked += 1;
      syncProgress.checked = checked;
      const needsDate = () => !order.actualDeliveryDate;
      let pageNote = order.trackingUrl ? null : 'no tracking link saved for this order';

      // Tier 1: read the order's own tracking link (raw HTML). Works for
      // Shiprocket and, for delivery confirmation + date, any other
      // partner's link. Reflects the live courier status rather than a
      // cached Shopify field or an account-scoped Delhivery lookup.
      const pageResult = await fetchTrackingPageStatus(order.trackingUrl);
      if (pageResult && pageResult.error) pageNote = `tracking link: ${pageResult.error}`;
      else if (pageResult && pageResult.notFound) pageNote = `tracking link: ${pageResult.reason || 'no status found'}`;

      if (pageResult && pageResult.packagedStatus) {
        const pageDate = pageResult.packagedStatus === 'Delivered' ? pageResult.deliveredDate : null;

        if (pageResult.packagedStatus !== order.packagedStatus) {
          const set = { packagedStatus: pageResult.packagedStatus, lastSyncedAt: new Date(), syncError: null };
          const stampedAt = deliveredAtStamp(pageResult.packagedStatus, order, pageDate);
          if (stampedAt) set.deliveredAt = stampedAt;
          const returnedStampedAt = returnedAtStamp(pageResult.packagedStatus, order);
          if (returnedStampedAt) set.returnedAt = returnedStampedAt;
          if (pageDate && needsDate()) set.actualDeliveryDate = pageDate;
          await Order.updateOne({ _id: order._id }, { $set: set });
          fromTrackingPage += 1;
          updatedCount += 1;
          if (set.actualDeliveryDate) datesFilled += 1;

          // Page said Delivered but had no readable date — ask Delhivery.
          if (pageResult.packagedStatus === 'Delivered' && !set.actualDeliveryDate && needsDate()) {
            const r = await apiLookup(order);
            if (r.packagedStatus === 'Delivered' && r.actualDeliveryDate) {
              await Order.updateOne({ _id: order._id }, { $set: { actualDeliveryDate: r.actualDeliveryDate } });
              datesFilled += 1;
            } else {
              noteIssue(order, 'marked Delivered from the link, but no delivery date in the page HTML and Delhivery has no date for it');
            }
          }
          await sleep(DELAY_MS);
          continue;
        }

        // Same status as stored.
        const wantsDateFromApi = pageResult.packagedStatus === 'Delivered' && needsDate() && !pageDate;
        if (!wantsDateFromApi) {
          const same = { lastSyncedAt: new Date(), syncError: null };
          if (pageDate && needsDate()) {
            same.actualDeliveryDate = pageDate;
            datesFilled += 1;
            updatedCount += 1;
          }
          await Order.updateOne({ _id: order._id }, { $set: same });
          await sleep(DELAY_MS);
          continue;
        }
        pageNote = 'link says Delivered but no date could be read from its HTML';
        // ...fall through to Delhivery's API for the date.
      }

      // Tier 2: Delhivery's own API — ref_id (our "NEAT-<orderNumber>"
      // convention) then the real AWB from Shopify's fulfillment
      // tracking, which catches orders booked through an aggregator that
      // still ship on Delhivery's network under Delhivery's own AWB.
      const result = await apiLookup(order);

      if (result.error) {
        errors += 1;
        await Order.updateOne({ _id: order._id }, { $set: { syncError: result.error, lastSyncedAt: new Date() } });
        if (order.packagedStatus === 'Delivered' && needsDate()) noteIssue(order, `Delhivery API error: ${result.error}${pageNote ? `; ${pageNote}` : ''}`);
        await sleep(DELAY_MS);
        continue;
      }
      if (result.notFound) {
        // Tier 3, last resort: Shopify's own carrier-reported
        // shipment_status (the same info shown on the order's page in
        // Shopify) — covers shipments neither the tracking link nor
        // Delhivery's API could resolve.
        const mapped = SHIPMENT_STATUS_MAP[order.shopifyShipmentStatus];
        if (mapped && mapped !== order.packagedStatus) {
          const set = { packagedStatus: mapped, lastSyncedAt: new Date(), syncError: null };
          const stampedAt = deliveredAtStamp(mapped, order);
          if (stampedAt) set.deliveredAt = stampedAt;
          const returnedStampedAt = returnedAtStamp(mapped, order);
          if (returnedStampedAt) set.returnedAt = returnedStampedAt;
          await Order.updateOne({ _id: order._id }, { $set: set });
          fromShopifyFallback += 1;
          if (mapped === 'Delivered') noteIssue(order, `Delivered per Shopify only — no date source (Delhivery has no record${pageNote ? `; ${pageNote}` : ''})`);
        } else {
          notFound += 1;
          if (order.packagedStatus === 'Delivered' && needsDate()) {
            noteIssue(order, `Delhivery has no record of this AWB${pageNote ? `; ${pageNote}` : ''}`);
          }
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
      if (result.packagedStatus === 'Delivered' && result.actualDeliveryDate && needsDate()) {
        set.actualDeliveryDate = result.actualDeliveryDate;
        datesFilled += 1;
      } else if (result.packagedStatus === 'Delivered' && needsDate()) {
        noteIssue(order, 'Delhivery says Delivered but returned no delivery date');
      }
      const stampedAt = deliveredAtStamp(result.packagedStatus, order, result.actualDeliveryDate || result.estimatedDeliveryDate);
      if (stampedAt) set.deliveredAt = stampedAt;
      const returnedStampedAt = returnedAtStamp(result.packagedStatus, order, result.returnedScanDate);
      if (returnedStampedAt) set.returnedAt = returnedStampedAt;

      // Pickup date: write-once, never overwritten once set — same as your script.
      if (!order.pickupDate && result.pickupDate) set.pickupDate = result.pickupDate;

      await Order.updateOne({ _id: order._id }, { $set: set });
      updatedCount += 1;
      await sleep(DELAY_MS);
    }
  } finally {
    syncProgress = null;
  }

  return { checked, updated: updatedCount, datesFilled, dateIssues, fromTrackingPage, fromShopifyFallback, notFound, errors, remaining: 0 };
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
