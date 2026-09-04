require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const connectDB = require('./config/db');
const apiRoutes = require('./routes/api');
const { runSync } = require('./services/syncService');

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

  // Kick off an initial sync shortly after boot, then repeat on a schedule.
  setTimeout(() => {
    runSync().catch((err) => console.error('[sync] initial sync failed:', err.message));
  }, 3000);

  const intervalMin = Number(process.env.SYNC_INTERVAL_MINUTES || 30);
  cron.schedule(`*/${intervalMin} * * * *`, () => {
    runSync().catch((err) => console.error('[sync] scheduled sync failed:', err.message));
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
