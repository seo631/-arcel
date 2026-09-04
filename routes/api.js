const express = require('express');
const multer = require('multer');
const router = express.Router();
const Order = require('../models/Order');
const { runSync, getLastSyncSummary, isSyncInProgress } = require('../services/syncService');
const { importFromWorkbook } = require('../services/excelImportService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx, .xls, or .csv files are accepted'), ok);
  },
});

// GET /api/orders?search=&status=&paymentMode=&from=&to=&page=&limit=
router.get('/orders', async (req, res) => {
  try {
    const { search, status, paymentMode, from, to } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Number(req.query.limit) || 50);

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
      if (from) query.orderDate.$gte = new Date(from);
      if (to) query.orderDate.$lte = new Date(to);
    }

    const [orders, total] = await Promise.all([
      Order.find(query)
        .sort({ orderDate: -1 })
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
    res.json({ statusCounts: agg, lastSync: getLastSyncSummary(), syncInProgress: isSyncInProgress() });
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
  runSync({ since, until }).catch((err) => console.error('[sync] failed:', err.message));
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

module.exports = router;
