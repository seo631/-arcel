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

    // --- Delhivery side ---
    refId: String, // "NEAT-16768" — what was actually queried
    pickupDate: Date, // write-once: never overwritten once set
    estimatedDeliveryDate: Date, // Delhivery's PromisedDeliveryDate || ExpectedDeliveryDate
    deliveredAt: Date, // set once packagedStatus === 'Delivered'
    packagedStatus: {
      type: String,
      enum: [
        'Not Yet Shipped', 'Pending', 'Manifested', 'Dispatched', 'In Transit',
        'Delivered', 'RTO Initiated', 'RTO In Transit', 'RTO Delivered',
        'Cancelled', 'Lost', 'Unknown',
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
