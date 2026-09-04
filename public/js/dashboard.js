const STATUS_COLORS = {
  'Delivered': 'var(--status-delivered)',
  'In Transit': 'var(--status-transit)',
  'Dispatched': 'var(--status-out)',
  'Pending': 'var(--status-pending)',
  'Manifested': 'var(--status-pending)',
  'RTO Initiated': 'var(--status-rto)',
  'RTO In Transit': 'var(--status-rto)',
  'RTO Delivered': 'var(--status-rto)',
  'Cancelled': 'var(--status-rto)',
  'Lost': 'var(--status-rto)',
  'Not Yet Shipped': 'var(--status-none)',
  'Unknown': 'var(--status-none)',
};

const state = {
  page: 1,
  limit: 50,
  search: '',
  status: '',
  paymentMode: '',
  from: '',
  to: '',
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

  const label = document.getElementById('lastSyncLabel');
  if (data.syncInProgress) {
    label.textContent = 'Syncing…';
  } else if (data.lastSync?.finishedAt) {
    label.textContent = `Last synced ${new Date(data.lastSync.finishedAt).toLocaleTimeString('en-IN')}`;
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
  const params = new URLSearchParams({ page: state.page, limit: state.limit });
  if (state.search) params.set('search', state.search);
  if (state.status) params.set('status', state.status);
  if (state.paymentMode) params.set('paymentMode', state.paymentMode);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);

  const body = document.getElementById('ordersBody');
  body.innerHTML = '<tr><td colspan="12" class="empty-state">Loading…</td></tr>';

  const data = await fetchJSON(`/api/orders?${params}`);

  if (!data.orders.length) {
    body.innerHTML = '<tr><td colspan="12" class="empty-state">No orders match these filters.</td></tr>';
  } else {
    body.innerHTML = data.orders.map(rowHTML).join('');
  }

  document.getElementById('pageLabel').textContent = `Page ${data.page} of ${data.pages || 1}`;
  document.getElementById('prevPage').disabled = data.page <= 1;
  document.getElementById('nextPage').disabled = data.page >= data.pages;

  document.querySelectorAll('.expand-btn').forEach((btn) => {
    btn.addEventListener('click', () => openDrawer(btn.dataset.id));
  });
}

function rowHTML(o) {
  const items = (o.lineItems || [])
    .map((li) => `<span class="item-name">${escapeHTML(li.name)}</span>`)
    .join('');
  const qty = o.totalQty ?? (o.lineItems || []).reduce((s, li) => s + (li.quantity || 0), 0);

  return `
    <tr>
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
      <td>${escapeHTML(o.paymentMode || '—')}</td>
      <td class="awb-cell">${escapeHTML(o.source === 'excel' ? 'via Excel' : '')}</td>
    </tr>
  `;
}

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

document.getElementById('syncBtn').onclick = async () => {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  await fetchJSON('/api/sync', { method: 'POST' });
  await waitForSyncToFinish();
  btn.disabled = false;
  btn.textContent = 'Refresh now';
  loadSummary();
  loadOrders();
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
    await fetchJSON('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since, until: until || undefined }),
    });
    await waitForSyncToFinish();
    note.className = 'sync-tool-note ok';
    note.textContent = 'Done.';
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
