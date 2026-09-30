/**
 * One-time backfill: fill `actualDeliveryDate` on orders that are already
 * marked Delivered but predate this field.
 *
 * For each such order it tries, in the same order as the live sync:
 *   1) the shiprocket.co tracking link (works for other courier partners)
 *   2) Delhivery's API (ref_id NEAT-<order no>, then the AWB)
 * A date is only ever written when a real source returned one — orders
 * where neither source has a date are left blank and reported.
 *
 * Usage:
 *   node scripts/backfill-actual-delivery.js            (all delivered orders missing the date)
 *   node scripts/backfill-actual-delivery.js --limit 20 (try a small batch first)
 * Needs MONGODB_URI and DELHIVERY_API_TOKEN (reads .env like the app).
 * Safe to re-run — only touches orders still missing the date.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { fetchByOrderNumber } = require('../services/delhiveryService');
const { fetchTrackingPageStatus } = require('../services/trackingPageService');

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
    .select('_id orderNumber trackingNumber trackingUrl')
    .sort({ orderDate: -1 });
  if (limit) q = q.limit(limit);
  const orders = await q;
  console.log(`[backfill] ${orders.length} delivered order(s) missing an actual delivery date`);

  let filled = 0;
  let noDate = 0;
  for (const [i, o] of orders.entries()) {
    let date = null;

    const page = await fetchTrackingPageStatus(o.trackingUrl);
    if (page && page.packagedStatus === 'Delivered' && page.deliveredDate) date = page.deliveredDate;

    if (!date) {
      let r = await fetchByOrderNumber(o.orderNumber, o.trackingNumber);
      if (r.rateLimited) {
        await sleep(Math.min(r.retryAfterSeconds, 60) * 1000);
        r = await fetchByOrderNumber(o.orderNumber, o.trackingNumber);
      }
      if (r.packagedStatus === 'Delivered' && r.actualDeliveryDate) date = r.actualDeliveryDate;
    }

    if (date) {
      await Order.updateOne({ _id: o._id }, { $set: { actualDeliveryDate: date } });
      filled += 1;
    } else {
      noDate += 1;
      console.log(`[backfill] no date found for order ${o.orderNumber}`);
    }
    if ((i + 1) % 25 === 0) console.log(`[backfill] ${i + 1}/${orders.length}...`);
    await sleep(300);
  }

  console.log(`[backfill] Done. Filled ${filled}, no date available for ${noDate}.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[backfill] failed:', err.message);
  process.exit(1);
});
