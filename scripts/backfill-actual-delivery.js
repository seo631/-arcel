/**
 * One-time backfill: fill `actualDeliveryDate` on orders already marked
 * Delivered that don't have one.
 *
 * Uses the same resolver as the dashboard's Check Delivery Status, in this
 * order, and never guesses:
 *   1) scan history stored on the order (no network)
 *   2) Delhivery API (ref_id NEAT-<order no>, then the AWB)
 *   3) raw HTML of the order's tracking link (other courier partners)
 *   4) Shopify fulfillment events
 * A date is written only when a real source returned one AND it passes a
 * plausibility check (not future, not before the order, not months after
 * it). Orders with no date from any source stay blank and are listed with
 * the reason.
 *
 * Usage:
 *   node scripts/backfill-actual-delivery.js            (all delivered orders missing the date)
 *   node scripts/backfill-actual-delivery.js --limit 20 (try a small batch first)
 * Needs MONGODB_URI, DELHIVERY_API_TOKEN and the Shopify vars (reads .env).
 * Safe to re-run — only touches orders still missing the date.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { findActualDeliveryDate } = require('../services/deliveryDateService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set.');
    process.exit(1);
  }
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) || 0 : 0;

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  let q = Order.find({ packagedStatus: 'Delivered', actualDeliveryDate: null })
    .select('_id orderNumber orderDate scanHistory shopifyId trackingNumber trackingUrl')
    .sort({ orderDate: -1 });
  if (limit) q = q.limit(limit);
  const orders = await q;
  console.log(`[backfill] ${orders.length} delivered order(s) missing an actual delivery date`);

  const bySource = {};
  let noDate = 0;
  for (const [i, o] of orders.entries()) {
    const found = await findActualDeliveryDate(o);
    if (found.date) {
      await Order.updateOne({ _id: o._id }, { $set: { actualDeliveryDate: found.date, actualDeliverySource: found.source } });
      bySource[found.source] = (bySource[found.source] || 0) + 1;
    } else {
      noDate += 1;
      console.log(`[backfill] #${o.orderNumber}: ${found.reasons.join('; ')}`);
    }
    if ((i + 1) % 25 === 0) console.log(`[backfill] ${i + 1}/${orders.length}...`);
    await sleep(300);
  }

  console.log('[backfill] Done. Filled:', bySource, `| no genuine date available: ${noDate}`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[backfill] failed:', err.message);
  process.exit(1);
});
