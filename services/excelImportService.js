const XLSX = require('xlsx');
const Order = require('../models/Order');

// Accepts several header spellings since exports/sheets rarely match exactly.
const HEADER_ALIASES = {
  orderDate: ['order date'],
  orderNumber: ['order id', 'order no', 'order number', 'order #'],
  customerName: ['customer name', 'customer'],
  mobileNo: ['mobile no', 'mobile no.', 'mobile', 'phone'],
  itemName: ['item name', 'item', 'product'],
  qty: ['qty', 'quantity'],
  pickupDate: ['pickup date'],
  estimatedDeliveryDate: ['estimate delivery date', 'estimate/actual delivery date', 'estimated delivery date', 'delivery date'],
  packagedStatus: ['packaged status', 'status', 'package status'],
  scanHistory: ['scan history', 'status journey'],
  paymentMode: ['payment mode', 'payment'],
};

function buildHeaderMap(headerRow) {
  const map = {}; // column index -> field name
  headerRow.forEach((raw, idx) => {
    const h = String(raw || '').trim().toLowerCase();
    if (!h) return;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(h)) {
        map[idx] = field;
        break;
      }
    }
  });
  return map;
}

function excelSerialToDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    // Excel serial date -> JS Date
    return new Date(Math.round((value - 25569) * 86400 * 1000));
  }
  const str = String(value).trim();
  // Handle dd/mm/yyyy (what the Apps Script writes) and ISO strings.
  const dmy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  const parsed = new Date(str);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Parses an uploaded workbook (buffer) and upserts orders into MongoDB.
 * Rows are grouped by Order ID since multi-item orders occupy one row
 * per line item, same as your sheet layout. Existing Shopify-sourced
 * fields are preserved; only fields present in the sheet are overwritten,
 * plus a couple of Delhivery fields that follow the same write-once /
 * status-driven rules as the live sync.
 */
async function importFromWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '' });

  if (!rows.length) return { error: 'Sheet is empty' };

  const headerMap = buildHeaderMap(rows[0]);
  if (!Object.values(headerMap).includes('orderNumber')) {
    return { error: 'Could not find an "Order ID" column in the first sheet — check the header row.' };
  }

  const grouped = {}; // orderNumber -> accumulated fields
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c === '' || c === null || c === undefined)) continue;

    const rec = {};
    Object.entries(headerMap).forEach(([idx, field]) => {
      rec[field] = row[Number(idx)];
    });

    const orderNumber = String(rec.orderNumber || '').trim();
    if (!orderNumber) continue;

    if (!grouped[orderNumber]) {
      grouped[orderNumber] = {
        orderNumber,
        orderDate: excelSerialToDate(rec.orderDate),
        customerName: rec.customerName || undefined,
        mobileNo: rec.mobileNo ? String(rec.mobileNo) : undefined,
        pickupDate: excelSerialToDate(rec.pickupDate),
        estimatedDeliveryDate: excelSerialToDate(rec.estimatedDeliveryDate),
        packagedStatus: rec.packagedStatus || undefined,
        paymentMode: rec.paymentMode || undefined,
        lineItems: [],
      };
    }
    if (rec.itemName) {
      grouped[orderNumber].lineItems.push({
        name: String(rec.itemName),
        quantity: Number(rec.qty) || 1,
      });
    }
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const [orderNumber, rec] of Object.entries(grouped)) {
    const existing = await Order.findOne({ orderNumber });

    const set = { orderNumber };
    if (rec.orderDate) set.orderDate = rec.orderDate;
    if (rec.customerName) set.customerName = rec.customerName;
    if (rec.mobileNo) set.mobileNo = rec.mobileNo;
    if (rec.lineItems.length) {
      set.lineItems = rec.lineItems;
      set.totalQty = rec.lineItems.reduce((s, li) => s + (li.quantity || 0), 0);
    }
    if (rec.paymentMode) set.paymentMode = rec.paymentMode;
    if (rec.packagedStatus) set.packagedStatus = rec.packagedStatus;
    // Pickup date stays write-once, matching the live sync's behaviour.
    if (rec.pickupDate && !(existing && existing.pickupDate)) set.pickupDate = rec.pickupDate;
    if (rec.estimatedDeliveryDate) set.estimatedDeliveryDate = rec.estimatedDeliveryDate;
    if (!existing) set.source = 'excel';
    set.lastSyncedAt = new Date();

    if (!existing && (!rec.customerName || !rec.lineItems.length)) {
      // Not enough to create a brand-new order record from this row alone.
      skipped += 1;
      continue;
    }

    const result = await Order.findOneAndUpdate(
      { orderNumber },
      { $set: set },
      { upsert: true, new: true, rawResult: true }
    );
    if (result.lastErrorObject?.updatedExisting) updated += 1;
    else created += 1;
  }

  return { totalRows: rows.length - 1, ordersInFile: Object.keys(grouped).length, created, updated, skipped };
}

module.exports = { importFromWorkbook };
