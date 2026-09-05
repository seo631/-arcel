# Neat Everyday — Order Tracking Dashboard

Node.js + Express + MongoDB, matching your existing Apps Script setup's
core logic — same Delhivery lookup method, same status vocabulary, same
rate-limit handling — but running as a standalone Render app.

Table shows: Order Date, Order ID, Customer Name, Mobile No, Item(s),
Qty, Pickup Date, Delivered/Est. Delivery Date, Status, Payment Mode —
plus a Scan History drawer per order.

## How it matches your Apps Script

- **Delhivery lookup**: `ref_ids=NEAT-{orderNumber}`, `token` as a query
  param, one order per call, same 429/403 retry-once behavior, same
  300ms pacing between calls.
- **Terminal statuses** (`Delivered`, `RTO Delivered`, `Cancelled`) are
  skipped on future syncs.
- **Pickup Date** is write-once — never overwritten once set.
- **Estimated delivery** uses `PromisedDeliveryDate || ExpectedDeliveryDate`.
  Once Delivered, the dashboard shows the delivered date instead.
- **Payment Mode**: exact `cod`/`prepaid` tag wins first, then falls
  back to the gateway name.
- **Scan History**: consecutive duplicate scan labels collapsed, shown
  newest-first in a side drawer.

Difference from Apps Script: Node isn't bound by its 6-minute execution
cap, so one sync run works through the whole pending queue at the same
safe pace instead of needing manual "next 50" clicks. Runs on a
schedule (`SYNC_INTERVAL_MINUTES`) or on demand from the dashboard.

## The date filter

`SHOPIFY_SYNC_START_DATE` in your env vars is a hard floor — orders
created before that date are never pulled. Set it to `2026-08-01` (or
whatever "recent" means to you). For a one-off scoped sync, use the
**Sync Shopify orders from / to** fields on the dashboard itself.

## Excel/CSV import (fallback for API limits)

**Import file** on the dashboard accepts a sheet with any of these
headers, any order: `Order Date`, `Order ID`, `Customer Name`,
`Mobile No`, `Item Name`, `Qty`, `Pickup Date`, `Estimate Delivery Date`,
`packaged status`, `Payment Mode`. Multi-item orders can be one row per
item, grouped by Order ID — same as your sheet. Existing records are
merged, not overwritten; a blank cell never erases a stored value, and
Pickup Date stays write-once.

---

## Deploying: GitHub + Render

### 1. Push this folder to GitHub

From inside the unzipped `neat-delhivery-dashboard` folder:

```bash
git init
git add .
git commit -m "Initial commit"
```

Create an empty repo on GitHub (github.com → New repository — **don't**
initialize it with a README), then:

```bash
git remote add origin https://github.com/<your-username>/neat-delhivery-dashboard.git
git branch -M main
git push -u origin main
```

`.env` is already in `.gitignore`, so your tokens never get committed —
only `.env.example` (the blank template) goes to GitHub.

### 2. Get your MongoDB Atlas connection string ready

If you don't already have a cluster for this (separate from your other
apps' databases is fine, or reuse the same cluster with a new database
name):

1. Atlas → Database → Connect → **Drivers** → copy the connection
   string (`mongodb+srv://...`).
2. Atlas → **Network Access** → Add IP Address → **Allow Access from
   Anywhere** (`0.0.0.0/0`). Render's outbound IPs aren't fixed on the
   free tier, so this is the simplest reliable option.
3. Swap `<password>` in the connection string for your actual database
   user's password, and add a database name before the `?` if it's not
   already there, e.g. `.../neat_delhivery_dashboard?retryWrites=true...`.

### 3. Create the Render service

**Option A — Blueprint (fastest):** this repo includes a `render.yaml`.
In Render, go to **New → Blueprint**, connect the GitHub repo, and
Render reads `render.yaml` and sets up the service with the right
build/start commands and env var slots automatically — you just need
to fill in the secret values (Step 4).

**Option B — Manual:**
1. Render → **New → Web Service** → connect your GitHub repo.
2. Runtime: **Node**. Build command: `npm install`. Start command:
   `npm start`.
3. Health check path: `/healthz`.
4. Plan: Free is fine to start.

### 4. Set environment variables

In Render → your service → **Environment**, add:

| Key | Value |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | your `.myshopify.com` domain |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | `shpat_...` — same token type your Apps Script uses |
| `SHOPIFY_SYNC_START_DATE` | e.g. `2026-08-01` |
| `DELHIVERY_API_TOKEN` | same token your Apps Script uses |
| `MONGODB_URI` | the connection string from Step 2 |

(`SHOPIFY_API_VERSION`, `DELHIVERY_BASE_URL`, `DELHIVERY_ORDER_ID_PREFIX`,
`ORDER_LOOKBACK_DAYS`, and `SYNC_INTERVAL_MINUTES` already have sensible
defaults in `render.yaml` / the code — only change them if you need to.)

### 5. Deploy and check

Render builds and deploys automatically after you save the env vars
(or click **Manual Deploy** if using the Blueprint). Once it's live:

- Open the service URL — the dashboard should load (empty at first).
- Check the **Logs** tab for `[db] Connected to MongoDB Atlas` and
  `[server] Dashboard running on port ...`. If you see a MongoDB
  connection error instead, it's almost always the Atlas Network
  Access step above.
- Click **Refresh now**, or set a **Sync Shopify orders from** date and
  click **Sync this range**, to pull in your first batch of orders.

### 6. Going forward

Every `git push` to `main` triggers an automatic redeploy (Render
watches the branch). Local development still works the same way:

```bash
npm install
cp .env.example .env   # fill in your real values
npm run dev
```

## Notes

- Fields your sheet tracks that aren't in this table yet (Inv No.,
  PDF Shard status) aren't modeled here — this covers the columns you
  asked for plus what's needed to compute them.
- No write-back to Shopify — this is view + track, not sync-back.
- The GST Pro invoice-PDF import isn't ported over — say the word if
  you want that as a separate upload flow here too.
