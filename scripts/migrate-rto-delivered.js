/**
 * One-time migration: 'RTO Delivered' -> 'RTO'.
 *
 * Why this is needed: the packagedStatus enum used to have 'RTO Delivered'
 * as its completed-return status. That's been renamed to a single flat
 * 'RTO' (matching Delhivery's own public wording, "Returned") — see
 * services/delhiveryService.js and models/Order.js. Any order already
 * sitting in the database with the old value needs a one-time fixup,
 * because 'RTO Delivered' is no longer a valid enum value: reads are
 * unaffected, but any future update on those specific documents would be
 * rejected by Mongoose schema validation until they're migrated.
 *
 * This also backfills the new `returnedAt` field for those rows. Under
 * the OLD code, a transition to 'RTO Delivered' stamped `deliveredAt`
 * (there was no separate returnedAt field yet) — so for these legacy
 * rows, `deliveredAt` is actually recording "when we detected the
 * return", not a real delivery date. This script moves that value over
 * to `returnedAt` and clears `deliveredAt`, so it stops being displayed/
 * treated as a delivery date elsewhere in the app (e.g. the dashboard's
 * "Est. Delivery" column falls back to deliveredAt when set).
 *
 * Usage:
 *   node scripts/migrate-rto-delivered.js
 * Requires MONGODB_URI in the environment (same as the app — reads
 * .env if present via the same dotenv setup as server.js).
 *
 * Safe to run more than once — after the first run, no documents match
 * the old status anymore, so later runs are a no-op.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set — add it to your .env or environment before running this.');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log('[migrate] Connected to MongoDB');

  // Talk to the raw collection, not the Order model — the model's schema
  // no longer allows 'RTO Delivered', and we want this migration to work
  // regardless of exactly which app version's schema is currently loaded.
  const collection = mongoose.connection.collection('orders');

  const matching = await collection.countDocuments({ packagedStatus: 'RTO Delivered' });
  console.log(`[migrate] Found ${matching} order(s) with packagedStatus "RTO Delivered"`);

  if (matching === 0) {
    console.log('[migrate] Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Pass 1: rows that have a deliveredAt to carry over to returnedAt.
  const withDate = await collection.updateMany(
    { packagedStatus: 'RTO Delivered', deliveredAt: { $exists: true, $ne: null } },
    [
      {
        $set: {
          packagedStatus: 'RTO',
          returnedAt: '$deliveredAt',
        },
      },
      { $unset: 'deliveredAt' },
    ]
  );

  // Pass 2: rows with no deliveredAt at all — just flip the status and
  // stamp returnedAt with "now" (best available fallback; we have no
  // record of when the return actually happened for these).
  const withoutDate = await collection.updateMany(
    { packagedStatus: 'RTO Delivered' },
    { $set: { packagedStatus: 'RTO', returnedAt: new Date() } }
  );

  console.log(`[migrate] Updated ${withDate.modifiedCount} row(s) using their existing deliveredAt as returnedAt`);
  console.log(`[migrate] Updated ${withoutDate.modifiedCount} row(s) with no prior date, stamped returnedAt = now`);
  console.log('[migrate] Done.');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
