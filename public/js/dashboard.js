const STATUS_COLORS = {
  'Delivered': 'var(--status-delivered)',
  'Hand Delivered': 'var(--status-delivered)',
  'In Transit': 'var(--status-transit)',
  'Dispatched': 'var(--status-out)',
  'Pending': 'var(--status-pending)',
  'Manifested': 'var(--status-pending)',
  'RTO Initiated': 'var(--status-rto)',
  'RTO In Transit': 'var(--status-rto)',
  'RTO Delivered': 'var(--status-rto)',
  'Cancelled': 'var(--status-rto)',
  'Lost': 'var(--status-rto)',
  'Failed Delivery': 'var(--status-rto)',
  'Not Yet Shipped': 'var(--status-none)',
  'Unknown': 'var(--status-none)',
};

const PACKAGED_STATUSES = [
  'Not Yet Shipped', 'Pending', 'Manifested', 'Dispatched', 'In Transit',
  'Delivered', 'Hand Delivered', 'RTO Initiated', 'RTO In Transit', 'RTO Delivered',
  'Cancelled', 'Lost', 'Failed Delivery', 'Unknown',
];

const state = {
  page: 1,
  limit: 50,
  sort: 'date_desc',
  search: '',
  status: '',
  paymentMode: '',
  from: '',
  to: '',
  total: 0, // total orders matching current filters (all pages), from last loadOrders()
  selected: new Set(), // orderNumbers checked via row/select-all checkboxes — persists across pages
};

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${url} -> ${res.status}`);
  return data;
}

function fmtDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date)) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function statusColor(status) {
  return STATUS_COLORS[status] || 'var(--status-none)';
}

async function loadSummary() {
  const data = await fetchJSON('/api/summary');
  renderStatusStrip(data.statusCounts);
  renderStatusFilterOptions(data.statusCounts);

  const SYNC_TYPE_LABEL = {
    shopify: 'Shopify sync',
    delhivery: 'Delivery status check',
    'delhivery-selected': 'Delivery status check (selected)',
    full: 'Full sync',
  };

  const label = document.getElementById('lastSyncLabel');
  if (data.syncInProgress) {
    label.textContent = data.syncProgress
      ? `Checking… ${data.syncProgress.checked}/${data.syncProgress.total}`
      : 'Syncing…';
  } else if (data.lastSync?.finishedAt) {
    const kind = SYNC_TYPE_LABEL[data.lastSync.type] || 'Synced';
    label.textContent = `Last ${kind.toLowerCase()} ${new Date(data.lastSync.finishedAt).toLocaleTimeString('en-IN')}`;
  } else {
    label.textContent = 'Not synced yet';
  }
}

function renderStatusStrip(counts) {
  const strip = document.getElementById('statusStrip');
  strip.innerHTML = '';
  counts.forEach(({ _id, count }) => {
    const chip = document.createElement('div');
    chip.className = 'status-chip' + (state.status === _id ? ' active' : '');
    chip.innerHTML = `<span class="dot" style="background:${statusColor(_id)}"></span>${_id || 'Unknown'} <span class="count">${count}</span>`;
    chip.onclick = () => {
      state.status = state.status === _id ? '' : _id;
      state.page = 1;
      document.getElementById('statusFilter').value = state.status;
      loadSummary();
      loadOrders();
    };
    strip.appendChild(chip);
  });
}

function renderStatusFilterOptions(counts) {
  const select = document.getElementById('statusFilter');
  const current = select.value;
  select.innerHTML = '<option value="">All statuses</option>' +
    counts.map(({ _id }) => `<option value="${_id}">${_id}</option>`).join('');
  select.value = current;
}

async function loadOrders() {
  const params = new URLSearchParams({ page: state.page, limit: state.limit, sort: state.sort });
  if (state.search) params.set('search', state.search);
  if (state.status) params.set('status', state.status);
  if (state.paymentMode) params.set('paymentMode', state.paymentMode);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);

  const body = document.getElementById('ordersBody');
  body.innerHTML = '<tr><td colspan="14" class="empty-state">Loading…</td></tr>';

  const data = await fetchJSON(`/api/orders?${params}`);
  state.total = data.total || 0;

  if (!data.orders.length) {
    body.innerHTML = '<tr><td colspan="14" class="empty-state">No orders match these filters.</td></tr>';
  } else {
    body.innerHTML = data.orders.map(rowHTML).join('');
  }

  document.getElementById('pageLabel').textContent = `Page ${data.page} of ${data.pages || 1}`;
  document.getElementById('prevPage').disabled = data.page <= 1;
  document.getElementById('nextPage').disabled = data.page >= data.pages;

  document.querySelectorAll('.expand-btn').forEach((btn) => {
    btn.addEventListener('click', () => openDrawer(btn.dataset.id));
  });

  document.querySelectorAll('.row-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      toggleRowSelection(cb.dataset.id, cb.checked);
    });
  });

  updateSelectAllState();
  updateSelectionToolbar();
}

function rowHTML(o) {
  const items = (o.lineItems || [])
    .map((li) => `<span class="item-name">${escapeHTML(li.name)}</span>`)
    .join('');
  const qty = o.totalQty ?? (o.lineItems || []).reduce((s, li) => s + (li.quantity || 0), 0);
  const isChecked = state.selected.has(o.orderNumber);

  // Tracking link for cross-checking — shown for ANY order with tracking
  // info from Shopify's fulfillment, not just non-Delhivery couriers, so
  // you can always jump straight to the carrier's own tracking page even
  // when our automated Delhivery/Shopify status lookups disagree with it.
  let awbCell = '—';
  if (o.trackingNumber || o.trackingUrl) {
    const label = escapeHTML(o.trackingNumber || 'Track');
    const courierLabel = o.courier ? `${escapeHTML(o.courier)}: ` : '';
    awbCell = o.trackingUrl
      ? `<a href="${escapeHTML(o.trackingUrl)}" target="_blank" rel="noopener">${courierLabel}${label}</a>`
      : `${courierLabel}${label}`;
  } else if (o.source === 'excel') {
    awbCell = 'via Excel';
  }

  return `
    <tr class="${isChecked ? 'row-selected' : ''}">
      <td><input type="checkbox" class="row-checkbox" data-id="${escapeHTML(o.orderNumber)}" ${isChecked ? 'checked' : ''} /></td>
      <td><button class="expand-btn" data-id="${o.orderNumber}" title="View scan history">&#9432;</button></td>
      <td>${fmtDate(o.orderDate)}</td>
      <td class="order-id">${escapeHTML(o.orderNumber)}</td>
      <td>${escapeHTML(o.customerName || '—')}</td>
      <td>${escapeHTML(o.mobileNo || '—')}</td>
      <td>${items || '—'}</td>
      <td>${qty || '—'}</td>
      <td>${fmtDate(o.pickupDate)}</td>
      <td>${fmtDate(o.deliveredAt || o.estimatedDeliveryDate)}</td>
      <td><span class="status-badge" style="background:${statusColor(o.packagedStatus)}">${escapeHTML(o.packagedStatus || 'Unknown')}</span></td>
      <td>${fmtDate(o.cancelledAt)}</td>
      <td>${escapeHTML(o.paymentMode || '—')}</td>
      <td class="awb-cell">${awbCell}</td>
    </tr>
  `;
}

// ---------- Row selection (checkboxes + toolbar) ----------
function toggleRowSelection(orderNumber, checked) {
  if (checked) state.selected.add(orderNumber);
  else state.selected.delete(orderNumber);

  const row = document.querySelector(`.row-checkbox[data-id="${cssEscape(orderNumber)}"]`)?.closest('tr');
  if (row) row.classList.toggle('row-selected', checked);

  updateSelectAllState();
  updateSelectionToolbar();
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

function updateSelectAllState() {
  const boxes = document.querySelectorAll('.row-checkbox');
  const selectAll = document.getElementById('selectAllCheckbox');
  if (!boxes.length) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    return;
  }
  const checkedCount = Array.from(boxes).filter((cb) => cb.checked).length;
  selectAll.checked = checkedCount === boxes.length;
  selectAll.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
}

function updateSelectionToolbar() {
  const toolbar = document.getElementById('selectionToolbar');
  const count = state.selected.size;
  document.getElementById('selectedCount').textContent = `${count} selected`;
  toolbar.hidden = count === 0;
  if (count === 0) document.getElementById('bulkActionNote').textContent = '';
}

document.getElementById('selectAllCheckbox').addEventListener('change', (e) => {
  const checked = e.target.checked;
  const boxes = document.querySelectorAll('.row-checkbox');
  boxes.forEach((cb) => {
    cb.checked = checked;
    if (checked) state.selected.add(cb.dataset.id);
    else state.selected.delete(cb.dataset.id);
    const row = cb.closest('tr');
    if (row) row.classList.toggle('row-selected', checked);
  });
  updateSelectAllState();
  updateSelectionToolbar();
});

document.getElementById('clearSelectionBtn').onclick = () => {
  state.selected.clear();
  document.querySelectorAll('.row-checkbox').forEach((cb) => { cb.checked = false; });
  document.querySelectorAll('tr.row-selected').forEach((tr) => tr.classList.remove('row-selected'));
  updateSelectAllState();
  updateSelectionToolbar();
};

document.getElementById('bulkStatusSelect').innerHTML =
  '<option value="">Set status to&hellip;</option>' +
  PACKAGED_STATUSES.map((s) => `<option value="${s}">${s}</option>`).join('');

document.getElementById('bulkUpdateBtn').onclick = async () => {
  const note = document.getElementById('bulkActionNote');
  const btn = document.getElementById('bulkUpdateBtn');
  const status = document.getElementById('bulkStatusSelect').value;
  const orderNumbers = Array.from(state.selected);

  if (!orderNumbers.length) return;
  if (!status) {
    note.className = 'sync-tool-note error';
    note.textContent = 'Pick a status first.';
    return;
  }

  btn.disabled = true;
  note.className = 'sync-tool-note';
  note.textContent = 'Updating…';
  try {
    const result = await fetchJSON('/api/orders/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumbers, status }),
    });
    note.className = 'sync-tool-note ok';
    note.textContent = `Updated ${result.modified} of ${result.matched} order(s) to "${status}".`;
    loadSummary();
    loadOrders();
  } catch (err) {
    note.className = 'sync-tool-note error';
    note.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

// ---- Check Delivery Status for just the checked rows — fast, and works
// even on an already-Delivered/Cancelled order since you picked it
// explicitly. Skips the rest of the "Not Yet Shipped" queue entirely. ----
document.getElementById('checkSelectedDelhiveryBtn').onclick = async () => {
  const note = document.getElementById('bulkActionNote');
  const btn = document.getElementById('checkSelectedDelhiveryBtn');
  const orderNumbers = Array.from(state.selected);

  if (!orderNumbers.length) return;

  btn.disabled = true;
  note.className = 'sync-tool-note';
  note.textContent = `Checking ${orderNumbers.length} order(s)…`;
  try {
    await fetchJSON('/api/sync/delhivery/selected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumbers }),
    });
    await waitForSyncToFinish();
    const summary = await fetchJSON('/api/summary');
    const d = summary.lastSync?.delhivery;
    note.className = 'sync-tool-note ok';
    note.textContent = d
      ? `Checked ${d.checked}, updated ${d.updated}${d.fromShopifyFallback ? ` (${d.fromShopifyFallback} from Shopify)` : ''}, not found ${d.notFound}, errors ${d.errors}.`
      : 'Done.';
    loadSummary();
    loadOrders();
  } catch (err) {
    note.className = 'sync-tool-note error';
    note.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

document.getElementById('downloadSelectedBtn').onclick = async () => {
  const note = document.getElementById('bulkActionNote');
  const btn = document.getElementById('downloadSelectedBtn');
  const orderNumbers = Array.from(state.selected);

  if (!orderNumbers.length) return;
  note.className = 'sync-tool-note';
  note.textContent = 'Preparing file…';
  try {
    const res = await fetch('/api/orders/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumbers }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Export failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orders-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    note.className = 'sync-tool-note ok';
    note.textContent = `Downloaded ${orderNumbers.length} order(s).`;
  } catch (err) {
    note.className = 'sync-tool-note error';
    note.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function openDrawer(orderNumber) {
  const drawer = document.getElementById('scanDrawer');
  const overlay = document.getElementById('drawerOverlay');
  const body = document.getElementById('drawerBody');
  const title = document.getElementById('drawerTitle');

  drawer.classList.add('open');
  overlay.classList.add('open');
  body.innerHTML = 'Loading…';

  try {
    const order = await fetchJSON(`/api/orders/${orderNumber}`);
    title.textContent = `Scan history — #${order.orderNumber}`;

    if (!order.scanHistory || !order.scanHistory.length) {
      body.innerHTML = `<p>No scan events yet${order.syncError ? ` — last sync error: ${escapeHTML(order.syncError)}` : ''}.</p>`;
      return;
    }

    body.innerHTML = order.scanHistory
      .slice()
      .reverse()
      .map(
        (s) => `
        <div class="scan-event">
          <time>${escapeHTML(s.date || '—')}</time>
          <strong>${escapeHTML(s.label || 'Scan')}</strong>
        </div>
      `
      )
      .join('');
  } catch (err) {
    body.innerHTML = `<p>Couldn't load scan history: ${escapeHTML(err.message)}</p>`;
  }
}

function closeDrawer() {
  document.getElementById('scanDrawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
}

// ---------- Event wiring ----------
document.getElementById('closeDrawer').onclick = closeDrawer;
document.getElementById('drawerOverlay').onclick = closeDrawer;

let searchTimer;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    state.page = 1;
    loadOrders();
  }, 350);
});

document.getElementById('statusFilter').addEventListener('change', (e) => {
  state.status = e.target.value;
  state.page = 1;
  loadOrders();
  loadSummary();
});

document.getElementById('paymentFilter').addEventListener('change', (e) => {
  state.paymentMode = e.target.value;
  state.page = 1;
  loadOrders();
});

document.getElementById('fromDate').addEventListener('change', (e) => {
  state.from = e.target.value;
  state.page = 1;
  loadOrders();
});

document.getElementById('toDate').addEventListener('change', (e) => {
  state.to = e.target.value;
  state.page = 1;
  loadOrders();
});

document.getElementById('pageSizeSelect').addEventListener('change', (e) => {
  state.limit = Number(e.target.value) || 50;
  state.page = 1;
  loadOrders();
});

document.getElementById('sortSelect').addEventListener('change', (e) => {
  state.sort = e.target.value;
  state.page = 1;
  loadOrders();
});

document.getElementById('clearFilters').onclick = () => {
  state.search = state.status = state.paymentMode = state.from = state.to = '';
  state.page = 1;
  document.getElementById('searchInput').value = '';
  document.getElementById('statusFilter').value = '';
  document.getElementById('paymentFilter').value = '';
  document.getElementById('fromDate').value = '';
  document.getElementById('toDate').value = '';
  loadOrders();
  loadSummary();
};

document.getElementById('prevPage').onclick = () => {
  if (state.page > 1) { state.page -= 1; loadOrders(); }
};
document.getElementById('nextPage').onclick = () => {
  state.page += 1; loadOrders();
};

async function waitForSyncToFinish() {
  return new Promise((resolve) => {
    const poll = setInterval(async () => {
      const summary = await fetchJSON('/api/summary');
      if (!summary.syncInProgress) {
        clearInterval(poll);
        resolve();
      }
    }, 2500);
  });
}

// ---- Sync: pull orders FROM Shopify only (doesn't touch Delhivery status) ----
document.getElementById('syncBtn').onclick = async () => {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    await fetchJSON('/api/sync/shopify', { method: 'POST' });
    await waitForSyncToFinish();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync Shopify Orders';
    loadSummary();
    loadOrders();
  }
};

// ---- Update Delivery Status: check LIVE status at Delhivery for every
// non-terminal order and refresh stats (doesn't pull in any new orders) ----
document.getElementById('deliveryStatusBtn').onclick = async () => {
  const btn = document.getElementById('deliveryStatusBtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    await fetchJSON('/api/sync/delhivery', { method: 'POST' });
    await waitForSyncToFinish();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Delivery Status';
    loadSummary();
    loadOrders();
  }
};

// ---- Sync a specific date range ----
document.getElementById('syncRangeBtn').onclick = async () => {
  const since = document.getElementById('syncSince').value;
  const until = document.getElementById('syncUntil').value;
  const note = document.getElementById('syncRangeNote');
  const btn = document.getElementById('syncRangeBtn');

  if (!since) {
    note.textContent = 'Pick a start date first.';
    note.className = 'sync-tool-note error';
    return;
  }

  btn.disabled = true;
  note.className = 'sync-tool-note';
  note.textContent = 'Syncing…';
  try {
    await fetchJSON('/api/sync/shopify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since, until: until || undefined }),
    });
    await waitForSyncToFinish();
    const summary = await fetchJSON('/api/summary');
    const s = summary.lastSync?.shopify;
    note.className = 'sync-tool-note ok';
    note.textContent = s
      ? `Fetched ${s.totalOrders} order(s) in range (${since} to ${until || 'today'}). New: ${s.created}, updated: ${s.updated}.`
      : 'Done.';
    loadSummary();
    loadOrders();
  } catch (err) {
    note.className = 'sync-tool-note error';
    note.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

// ---- Excel/CSV import (fallback when the APIs are unavailable) ----
document.getElementById('excelUploadBtn').onclick = async () => {
  const fileInput = document.getElementById('excelFile');
  const note = document.getElementById('excelNote');
  const btn = document.getElementById('excelUploadBtn');

  if (!fileInput.files.length) {
    note.className = 'sync-tool-note error';
    note.textContent = 'Choose a file first.';
    return;
  }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);

  btn.disabled = true;
  note.className = 'sync-tool-note';
  note.textContent = 'Importing…';
  try {
    const result = await fetchJSON('/api/import/excel', { method: 'POST', body: formData });
    note.className = 'sync-tool-note ok';
    note.textContent = `Imported: ${result.created} new, ${result.updated} updated, ${result.skipped} skipped.`;
    loadSummary();
    loadOrders();
  } catch (err) {
    note.className = 'sync-tool-note error';
    note.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

// ---------- Init ----------
loadSummary();
loadOrders();
setInterval(loadSummary, 30000);
