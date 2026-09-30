const mongoose = require('mongoose');

const LineItemSchema = new mongoose.Schema(
  {
    name: String,
    sku: String,
    quantity: Number,
  },
  { _id: false }
);

const ScanEventSchema = new mongoose.Schema(
  {
    date: String, // e.g. "3 Sep" — Delhivery's own compact format
    label: String, // scan description, consecutive duplicates collapsed
    iso: String, // full YYYY-MM-DD of the scan (newer syncs only — `date` above has no year)
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    // --- Identity ---
    // shopifyId: Shopify's internal numeric order id — stable unique key.
    // orderNumber: the human order number (e.g. "16768"), used to build
    // the Delhivery ref_id as `NEAT-{orderNumber}`, matching your existing
    // Apps Script setup. Excel-imported rows may only have orderNumber.
    shopifyId: { type: String, unique: true, sparse: true },
    orderNumber: { type: String, required: true, index: true },

    // --- Shopify side ---
    orderDate: Date,
    customerName: String,
    mobileNo: String,
    email: String,
    lineItems: [LineItemSchema],
    totalQty: Number,
    paymentMode: String, // COD / Prepaid
    orderValue: Number,
    currency: String,
    shopifyFulfillmentStatus: String,
    shopifyFinancialStatus: String,
    shippingAddress: {
      city: String,
      state: String,
      pincode: String,
    },
    tags: [String],

    // --- Non-Delhivery courier fallback ---
    // For orders NOT shipped via Delhivery, Delhivery's tracking API can
    // never find them — Shopify's own fulfillment tracking (what shows on
    // the order page) is the only source of live status for these.
    courier: String, // Shopify's tracking_company, e.g. "Shiprocket", "Delhivery"
    trackingNumber: String,
    trackingUrl: String,
    shopifyShipmentStatus: String, // Shopify's raw shipment_status value

    // --- Delhivery side ---
    refId: String, // "NEAT-16768" — what was actually queried
    pickupDate: Date, // write-once: never overwritten once set
    estimatedDeliveryDate: Date, // Delhivery's PromisedDeliveryDate || ExpectedDeliveryDate
    deliveredAt: Date, // set once packagedStatus === 'Delivered' — drives the recheck window only, NOT shown as the delivery date
    // The real date the courier marked the parcel delivered — read from
    // Delhivery's API (DeliveryDate / DL status / delivered scan) or, for
    // other partners, from the delivered entry on their tracking-link
    // page. Only ever set from a real source (never "now"), so blank
    // means "delivered but the date couldn't be read", not a guess.
    actualDeliveryDate: Date,
    actualDeliverySource: String, // where it came from: scan history / Delhivery API / tracking link / Shopify / excel / manual — for auditing
    returnedAt: Date, // set once packagedStatus === 'RTO' — the actual return-scan date when known, not just when we happened to sync
    packagedStatus: {
      type: String,
      enum: [
        'Not Yet Shipped', 'Pending', 'Manifested', 'Dispatched', 'In Transit',
        'Delivered', 'RTO Initiated', 'RTO In Transit', 'RTO',
        'Cancelled', 'Lost', 'Unknown', 'Failed Delivery', 'Hand Delivered',
      ],
      default: 'Not Yet Shipped',
    },
    scanHistory: [ScanEventSchema], // collapsed journey, oldest first
    ndrReason: String,
    cancelledAt: Date, // set from Shopify's cancelled_at — drives auto "Cancelled" status

    // --- housekeeping ---
    source: { type: String, enum: ['shopify', 'excel'], default: 'shopify' },
    lastSyncedAt: Date,
    syncError: String,
  },
  { timestamps: true }
);

OrderSchema.index({ orderDate: -1 });
OrderSchema.index({ packagedStatus: 1 });

module.exports = mongoose.model('Order', OrderSchema);
