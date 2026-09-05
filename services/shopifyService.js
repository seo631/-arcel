const axios = require('axios');

function shopifyClient() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2024-10';

  if (!domain || !token) {
    throw new Error('SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_ACCESS_TOKEN missing in .env');
  }

  return axios.create({
    baseURL: `https://${domain}/admin/api/${version}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

function paymentModeOf(order) {
  // Matches your Apps Script logic: exact "cod"/"prepaid" tag wins first
  // (so a tag like "Gokwik_cod_fees" never false-matches), then falls
  // back to the payment gateway name.
  const tags = String(order.tags || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tags.includes('cod')) return 'COD';
  if (tags.includes('prepaid')) return 'Prepaid';

  const gatewayNames = (order.payment_gateway_names || []).join(', ').toLowerCase();
  const gatewayField = String(order.gateway || '').toLowerCase();
  const combined = `${gatewayNames} ${gatewayField}`;

  if (combined.includes('cod') || combined.includes('cash on delivery')) return 'COD';
  if (gatewayNames || gatewayField) return 'Prepaid';
  return '';
}

// Shopify's own carrier-reported delivery status for a fulfillment
// (fulfillment.shipment_status), mapped onto our packagedStatus enum.
// This only matters for orders shipped via a courier OTHER than
// Delhivery, since Delhivery orders get their live status from the
// Delhivery API instead — this is purely the fallback for "some other
// courier partner" shipments, where Shopify's own tracking widget (the
// one on the order page) is the only place that status shows up.
const SHIPMENT_STATUS_MAP = {
  label_purchased: 'Manifested',
  label_printed: 'Manifested',
  confirmed: 'Manifested',
  ready_for_pickup: 'Manifested',
  picked_up: 'Dispatched',
  in_transit: 'In Transit',
  out_for_delivery: 'In Transit',
  out_for_pickup: 'In Transit',
  attempted_delivery: 'Failed Delivery',
  failure: 'Failed Delivery',
  delivered: 'Delivered',
};

function isDelhiveryCourier(name) {
  return !!name && /delhivery/i.test(name);
}

// Pulls tracking company/number/url and Shopify's own delivery status off
// the most recent non-cancelled fulfillment. An order can have more than
// one fulfillment (partial shipments) — the latest one is what's actually
// relevant right now.
function extractFulfillmentInfo(order) {
  const fulfillments = (order.fulfillments || []).filter((f) => f.status !== 'cancelled');
  if (!fulfillments.length) return {};
  const f = fulfillments[fulfillments.length - 1];
  return {
    courier: f.tracking_company || null,
    trackingNumber: f.tracking_number || (f.tracking_numbers && f.tracking_numbers[0]) || null,
    trackingUrl: f.tracking_url || (f.tracking_urls && f.tracking_urls[0]) || null,
    shopifyShipmentStatus: f.shipment_status || null,
  };
}

function normalizeOrder(order) {
  const address = order.shipping_address || {};
  return {
    shopifyId: String(order.id),
    orderNumber: String(order.order_number),
    orderDate: order.created_at,
    customerName:
      [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') ||
      address.name ||
      'Guest',
    mobileNo: order.phone || address.phone || order.customer?.phone || '',
    email: order.email,
    lineItems: (order.line_items || []).map((li) => {
      const variant = li.variant_title && li.variant_title !== 'Default Title' ? ` - ${li.variant_title}` : '';
      return { name: `${li.title}${variant}`, sku: li.sku, quantity: li.quantity };
    }),
    totalQty: (order.line_items || []).reduce((sum, li) => sum + (li.quantity || 0), 0),
    paymentMode: paymentModeOf(order),
    orderValue: Number(order.total_price || 0),
    currency: order.currency,
    shopifyFulfillmentStatus: order.fulfillment_status || 'unfulfilled',
    shopifyFinancialStatus: order.financial_status,
    cancelledAt: order.cancelled_at || null,
    ...extractFulfillmentInfo(order),
    shippingAddress: {
      city: address.city,
      state: address.province,
      pincode: address.zip,
    },
    tags: (order.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    source: 'shopify',
  };
}

function nextPageUrl(res, baseURL) {
  const link = res.headers.link || res.headers.Link;
  const next = link && link.split(',').find((p) => p.includes('rel="next"'));
  if (!next) return null;
  const match = next.match(/<([^>]+)>/);
  return match ? match[1].replace(baseURL, '') : null;
}

/**
 * Fetches Shopify orders created on/after `sinceISO`. This is the main
 * date filter — keep it tight (recent orders only) so syncs stay fast
 * and cheap on API calls. Defaults to SHOPIFY_SYNC_START_DATE from .env,
 * or falls back to ORDER_LOOKBACK_DAYS if that's not set.
 */
async function fetchOrdersSince(sinceISO, untilISO) {
  const client = shopifyClient();
  let url = `/orders.json?status=any&created_at_min=${encodeURIComponent(sinceISO)}&limit=250&order=created_at asc`;
  if (untilISO) url += `&created_at_max=${encodeURIComponent(untilISO)}`;

  const all = [];
  while (url) {
    const res = await client.get(url);
    all.push(...res.data.orders);
    url = nextPageUrl(res, client.defaults.baseURL);
  }
  return all.map(normalizeOrder);
}

function resolveDefaultSince() {
  const explicit = process.env.SHOPIFY_SYNC_START_DATE; // e.g. "2026-08-01"
  if (explicit) return new Date(explicit).toISOString();
  const lookbackDays = Number(process.env.ORDER_LOOKBACK_DAYS || 30);
  return new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
}

async function fetchRecentOrders() {
  return fetchOrdersSince(resolveDefaultSince());
}

module.exports = {
  fetchRecentOrders,
  fetchOrdersSince,
  resolveDefaultSince,
  normalizeOrder,
  isDelhiveryCourier,
  SHIPMENT_STATUS_MAP,
};
