const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const router = express.Router();
const Order = require('../models/Order');
const {
  runSync,
  runShopifySync,
  runDelhiveryTracking,
  runDelhiverySelected,
  getLastSyncSummary,
  isSyncInProgress,
  getSyncProgress,
} = require('../services/syncService');
const { importFromWorkbook } = require('../services/excelImportService');

const PACKAGED_STATUSES = [
  'Not Yet Shipped', 'Pending', 'Manifested', 'Dispatched', 'In Transit',
  'Delivered', 'Hand Delivered', 'RTO Initiated', 'RTO In Transit', 'RTO Delivered',
  'Cancelled', 'Lost', 'Failed Delivery', 'Unknown',
];

// A bare "YYYY-MM-DD" from an <input type="date"> means midnight at the
// START of that day. Shopify's created_at_min/max are exact instants, so
// using the bare date for `until` silently excludes almost the entire
// day (everything created after 00:00:00). `since` is fine as-is (start
// of day is what "from" should mean) — only `until` needs pushing to the
// end of that day. Anchored to IST since that's the store's timezone.
function normalizeUntil(until) {
  if (!until) return until;
  if (/^\d{4}-\d{2}-\d{2}$/.test(until)) return `${until}T23:59:59.999+05:30`;
  return until;
}
function normalizeSince(since) {
  if (!since) return since;
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) return `${since}T00:00:00.000+05:30`;
  return since;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx, .xls, or .csv files are accepted'), ok);
  },
});

function buildOrderQuery({ search, status, paymentMode, from, to }) {
  const query = {};
  if (search) {
    const re = new RegExp(search.trim(), 'i');
    query.$or = [
      { orderNumber: re },
      { customerName: re },
      { mobileNo: re },
      { 'lineItems.name': re },
    ];
  }
  if (status) query.packagedStatus = status;
  if (paymentMode) query.paymentMode = paymentMode;
  if (from || to) {
    query.orderDate = {};
    if (from) query.orderDate.$gte = new Date(normalizeSince(from));
    if (to) query.orderDate.$lte = new Date(normalizeUntil(to));
  }
  return query;
}

const SORT_OPTIONS = {
  date_desc: { orderDate: -1 },
  date_asc: { orderDate: 1 },
};

// GET /api/orders?search=&status=&paymentMode=&from=&to=&page=&limit=&sort=
router.get('/orders', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const sort = SORT_OPTIONS[req.query.sort] || SORT_OPTIONS.date_desc;
    const query = buildOrderQuery(req.query);

    const [orders, total] = await Promise.all([
      Order.find(query)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Order.countDocuments(query),
    ]);

    res.json({ orders, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/:orderNumber (full detail incl. scan history)
router.get('/orders/:orderNumber', async (req, res) => {
  try {
    const order = await Order.findOne({ orderNumber: req.params.orderNumber }).lean();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/summary
router.get('/summary', async (req, res) => {
  try {
    const agg = await Order.aggregate([
      { $group: { _id: '$packagedStatus', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json({
      statusCounts: agg,
      lastSync: getLastSyncSummary(),
      syncInProgress: isSyncInProgress(),
      syncProgress: getSyncProgress(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync  { since?: "2026-08-01", until?: "2026-08-31" }
// Defaults to SHOPIFY_SYNC_START_DATE / ORDER_LOOKBACK_DAYS from .env
// when no range is given — i.e. "recent orders only", not the full
// order history.
router.post('/sync', async (req, res) => {
  if (isSyncInProgress()) {
    return res.status(202).json({ message: 'Sync already in progress' });
  }
  const { since, until } = req.body || {};
  res.json({ message: 'Sync started', range: { since: since || 'default', until: until || null } });
  runSync({ since: normalizeSince(since), until: normalizeUntil(until) }).catch((err) => console.error('[sync] failed:', err.message));
});

// GET /api/cron/shopify-sync
// A GET (not POST) so any uptime monitor can hit it directly on a
// schedule — most free monitors only support GET. Does the SAME thing as
// the "Sync Shopify Orders" button: pulls new orders, never touches
// Delhivery, so it's cheap enough to run every 15-30 min without ever
// triggering the slow 1000+-order Delhivery check. Safe to call
// repeatedly — if a sync is already running it just no-ops.
router.get('/cron/shopify-sync', (req, res) => {
  if (isSyncInProgress()) {
    return res.status(202).json({ status: 'skipped', reason: 'A sync is already running' });
  }
  res.json({ status: 'started' });
  runShopifySync().catch((err) => console.error('[cron:shopify-sync] failed:', err.message));
});

// POST /api/sync/shopify  { since?: "2026-08-01", until?: "2026-08-31" }
// "Sync" button — fetches/upserts orders FROM Shopify only. Does not touch
// Delhivery, so existing tracking status on orders is left untouched.
router.post('/sync/shopify', async (req, res) => {
  if (isSyncInProgress()) {
    return res.status(202).json({ message: 'Sync already in progress' });
  }
  const { since, until } = req.body || {};
  res.json({ message: 'Shopify sync started', range: { since: since || 'default', until: until || null } });
  runShopifySync({ since: normalizeSince(since), until: normalizeUntil(until) }).catch((err) => console.error('[sync:shopify] failed:', err.message));
});

// POST /api/sync/delhivery
// "Update Delivery Status" button — checks LIVE tracking status at
// Delhivery for every order not already Delivered/RTO Delivered/Cancelled,
// and updates packagedStatus/scanHistory/etc. Does not touch Shopify or
// pull in any new orders. Can take a while with a large queue — poll
// /api/summary's syncProgress for a live checked/total count.
router.post('/sync/delhivery', async (req, res) => {
  if (isSyncInProgress()) {
    return res.status(202).json({ message: 'Sync already in progress' });
  }
  res.json({ message: 'Delivery status update started' });
  runDelhiveryTracking().catch((err) => console.error('[sync:delhivery] failed:', err.message));
});

// POST /api/sync/delhivery/selected  { orderNumbers: ["17111", ...] }
// "Update Delivery Status" for just the checked rows — bypasses the
// terminal-status filter (so it re-checks even a Delivered/Cancelled
// order if you explicitly selected it) and skips the rest of the queue,
// so a handful of orders finishes in seconds instead of waiting behind
// everything else that's still "Not Yet Shipped".
router.post('/sync/delhivery/selected', async (req, res) => {
  if (isSyncInProgress()) {
    return res.status(202).json({ message: 'Sync already in progress' });
  }
  const { orderNumbers } = req.body || {};
  if (!Array.isArray(orderNumbers) || !orderNumbers.length) {
    return res.status(400).json({ error: 'orderNumbers must be a non-empty array' });
  }
  res.json({ message: 'Delivery status check started', count: orderNumbers.length });
  runDelhiverySelected(orderNumbers).catch((err) => console.error('[sync:delhivery:selected] failed:', err.message));
});

// POST /api/import/excel  (multipart form field name: "file")
// Fallback path for when the Shopify/Delhivery APIs are rate-limited or
// unavailable — upload a sheet exported the same way your Apps Script
// sheet is laid out (Order Date, Order ID, Customer Name, Mobile No,
// Item Name, Qty, Pickup Date, Estimate Delivery Date, packaged status,
// Payment Mode) and it merges into the same order records.
router.post('/import/excel', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
    const result = await importFromWorkbook(req.file.buffer);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/status  { orderNumbers: ["16768", ...], status: "Delivered" }
// Bulk-updates packagedStatus for the checked orders (from the checkbox
// column + "Update status" button in the toolbar). Manual overrides like
// this are expected to get clobbered by the next Shopify/Delhivery sync
// unless the sync logic is told to respect them — that's out of scope here.
router.patch('/orders/status', async (req, res) => {
  try {
    const { orderNumbers, status } = req.body || {};

    if (!Array.isArray(orderNumbers) || !orderNumbers.length) {
      return res.status(400).json({ error: 'orderNumbers must be a non-empty array' });
    }
    if (!status || !PACKAGED_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${PACKAGED_STATUSES.join(', ')}` });
    }

    const update = { packagedStatus: status };
    if (status === 'Delivered') update.deliveredAt = new Date();

    const result = await Order.updateMany(
      { orderNumber: { $in: orderNumbers } },
      { $set: update }
    );

    res.json({
      matched: result.matchedCount ?? result.n,
      modified: result.modifiedCount ?? result.nModified,
      status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/export  { orderNumbers: ["16768", ...] }
// Excel export of only the checked/selected orders (not the full filtered
// list) — used by the "Download selected" button.
router.post('/orders/export', async (req, res) => {
  try {
    const { orderNumbers } = req.body || {};

    if (!Array.isArray(orderNumbers) || !orderNumbers.length) {
      return res.status(400).json({ error: 'orderNumbers must be a non-empty array' });
    }

    const orders = await Order.find({ orderNumber: { $in: orderNumbers } })
      .sort({ orderDate: -1 })
      .lean();

    const rows = orders.flatMap((o) => {
      // Shared fields — identical across every row for this order.
      const base = {
        orderDate: o.orderDate ? new Date(o.orderDate).toLocaleDateString('en-IN') : '',
        orderId: o.orderNumber || '',
        customer: o.customerName || '',
        mobile: o.mobileNo || '',
        pickupDate: o.pickupDate ? new Date(o.pickupDate).toLocaleDateString('en-IN') : '',
        estDelivery: o.estimatedDeliveryDate ? new Date(o.estimatedDeliveryDate).toLocaleDateString('en-IN') : '',
        status: o.packagedStatus || '',
        cancelledOn: o.cancelledAt ? new Date(o.cancelledAt).toLocaleDateString('en-IN') : '',
        paymentMode: o.paymentMode || '',
        orderValue: o.orderValue ?? '',
        tracking: o.trackingNumber ? `${o.courier ? `${o.courier}: ` : ''}${o.trackingNumber}` : '',
        city: o.shippingAddress?.city || '',
        state: o.shippingAddress?.state || '',
        pincode: o.shippingAddress?.pincode || '',
      };

      // One row PER line item — only Item Name and Qty differ between an
      // order's rows, everything else (dates, customer, status, etc.)
      // repeats identically, matching your original sheet's layout.
      const items = o.lineItems && o.lineItems.length ? o.lineItems : [{ name: '', quantity: '' }];
      return items.map((li) => ({
        'Order Date': base.orderDate,
        'Order ID': base.orderId,
        'Customer': base.customer,
        'Mobile No.': base.mobile,
        'Item Name': li.name || '',
        'Qty': li.quantity ?? '',
        'Pickup Date': base.pickupDate,
        'Est. Delivery': base.estDelivery,
        'Status': base.status,
        'Cancelled On': base.cancelledOn,
        'Payment Mode': base.paymentMode,
        'Order Value': base.orderValue,
        'AWB / Tracking': base.tracking,
        'City': base.city,
        'State': base.state,
        'Pincode': base.pincode,
      }));
    });

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Selected Orders');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const filename = `orders-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
