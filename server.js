require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const connectDB = require('./config/db');
const apiRoutes = require('./routes/api');
const { runSync, runShopifySync, runDelhiveryTracking } = require('./services/syncService');

const app = express();
app.use(cors());
app.use(express.json());

// Render (and any uptime monitor) can hit this without touching Mongo/APIs.
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api', apiRoutes);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

async function start() {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`[server] Dashboard running on port ${PORT}`);
  });

  // Kick off one combined sync (Shopify + Delhivery) shortly after boot so
  // the dashboard has fresh data immediately, then the two pieces run on
  // their own separate schedules below.
  setTimeout(() => {
    runSync().catch((err) => console.error('[sync] initial sync failed:', err.message));
  }, 3000);

  // Shopify order pull — frequent, since new orders/cancellations should
  // show up quickly. Never touches Delhivery/courier status.
  const shopifyIntervalMin = Number(process.env.SYNC_INTERVAL_MINUTES || 30);
  cron.schedule(`*/${shopifyIntervalMin} * * * *`, () => {
    runShopifySync().catch((err) => console.error('[sync:shopify] scheduled sync failed:', err.message));
  });

  // Delhivery/courier status check — deliberately much less frequent,
  // since it's an API call per pending order and the status doesn't
  // change minute to minute. Runs at minute 0 every N hours.
  const deliveryIntervalHours = Number(process.env.DELIVERY_STATUS_INTERVAL_HOURS || 12);
  cron.schedule(`0 */${deliveryIntervalHours} * * *`, () => {
    runDelhiveryTracking().catch((err) => console.error('[sync:delhivery] scheduled check failed:', err.message));
  });
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
