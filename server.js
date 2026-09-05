require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const connectDB = require('./config/db');
const apiRoutes = require('./routes/api');

const app = express();
app.use(cors());
app.use(express.json());

// Render (and any uptime monitor) can hit this without touching Mongo/APIs.
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
// Plain health check some monitors expect a minimal { status: "ok" } body from.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', apiRoutes);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

async function start() {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`[server] Dashboard running on port ${PORT}`);
  });

  // No automatic sync on boot or on a schedule — syncing is 100% manual,
  // triggered only by the "Sync Shopify Orders" / "Update Delivery
  // Status" / "Check Delivery Status" buttons in the dashboard. This
  // matters because the host puts the server to sleep when idle, and
  // every wake-up is a fresh boot — an automatic sync here would have
  // silently kicked off a full 1000+ order Delhivery check on every
  // single wake-up, which is exactly what was happening before.
}

start().catch((err) => {
  console.error('[server] failed to start:', err.message);
  process.exit(1);
});

// Render restarts the process on unhandled crashes anyway, but log clearly
// instead of dying silently on a stray rejected promise from a background sync.
process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err);
});
