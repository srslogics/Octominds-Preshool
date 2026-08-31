const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const config = window.OCTOMINDS_CONFIG || {};
const SESSION_KEY = 'octominds.inventory.session';
const inventoryState = { page: 1, pageSize: 25, search: '', stockStatus: 'all', items: [], total: 0, lookups: null, loading: false };
let session = null;
let currentUser = null;
let toastTimer;

function configured() {
  return Boolean(config.supabaseUrl && config.supabaseAnonKey && config.apiBaseUrl);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function showToast(message, kind = 'info') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${config.supabaseUrl}/auth/v1${path}`, {
    ...options,
    headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.msg || payload.message || 'Authentication request failed');
  return payload;
}

async function apiRequest(path, options = {}) {
  if (!session?.access_token) throw new Error('Authentication required');
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail;
    throw new Error((typeof detail === 'object' && detail?.message) || detail || 'Inventory request failed');
  }
  return payload;
}

function saveSession(value, persistent) {
  session = value;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  if (persistent) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else localStorage.removeItem(SESSION_KEY);
}

function clearSession() {
  session = null;
  currentUser = null;
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
}

function showLogin() {
  $('#appView').classList.add('hidden');
  $('#authView').classList.remove('hidden');
}

function userInitials(name) {
  return (name || 'OctoMinds User').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}

async function showApplication() {
  currentUser = await apiRequest('/api/v1/session');
  const allowed = ['super_admin', 'management', 'branch_admin', 'accountant'];
  if (!allowed.includes(currentUser.role)) throw new Error('Inventory access is not assigned to this account');
  const role = currentUser.role_label || currentUser.role.replaceAll('_', ' ');
  const initials = userInitials(currentUser.full_name);
  $('#sidebarAvatar').textContent = $('#topbarAvatar').textContent = initials;
  $('#sidebarName').textContent = currentUser.full_name || 'OctoMinds user';
  $('#sidebarRole').textContent = role;
  $('#topbarBranch').textContent = currentUser.branch_name || 'All branches';
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  await loadInventory();
}

async function signInWithPin(phone, pin, persistent) {
  const nationalNumber = phone.replace(/\D/g, '').slice(-10);
  const loginEmail = `${nationalNumber}@auth.octominds.invalid`;
  const value = await supabaseRequest('/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: loginEmail, password: pin }) });
  saveSession(value, persistent);
  try { await showApplication(); } catch (error) { clearSession(); throw error; }
}

async function restoreSession() {
  if (!configured()) return;
  const stored = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
  if (!stored) return;
  try {
    session = JSON.parse(stored);
    if (session.expires_at && session.expires_at * 1000 <= Date.now() && session.refresh_token) {
      const refreshed = await supabaseRequest('/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) });
      saveSession(refreshed, Boolean(localStorage.getItem(SESSION_KEY)));
    }
    await showApplication();
  } catch { clearSession(); showLogin(); }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    if (!configured()) throw new Error('Application environment is not configured');
    await signInWithPin($('#phone').value, $('#pin').value, $('#rememberSession').checked);
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; button.innerHTML = 'Open inventory <i class="bi bi-arrow-right"></i>'; }
});

$('#togglePin').addEventListener('click', () => {
  const pin = $('#pin');
  const visible = pin.type === 'text';
  pin.type = visible ? 'password' : 'text';
  $('#togglePin').textContent = visible ? 'Show' : 'Hide';
  $('#togglePin').setAttribute('aria-label', visible ? 'Show PIN' : 'Hide PIN');
});

$('#forgotPin').addEventListener('click', () => showToast('Ask an OctoMinds administrator to reset your PIN'));
$('#logoutButton').addEventListener('click', () => { clearSession(); showLogin(); showToast('Signed out safely'); });

function inventoryBranchId() {
  return $('#inventoryBranchSelect')?.value || currentUser?.branch_id || '';
}

function canWriteInventory() {
  return ['super_admin', 'management', 'branch_admin'].includes(currentUser?.role);
}

function inventoryPath(path, parameters = {}) {
  const query = new URLSearchParams();
  Object.entries(parameters).forEach(([key, value]) => { if (value !== '' && value !== null && value !== undefined) query.set(key, value); });
  const branchId = inventoryBranchId();
  if (branchId) query.set('branch_id', branchId);
  return `/api/v1/inventory${path}${query.size ? `?${query}` : ''}`;
}

function setInventoryLoading(loading) {
  inventoryState.loading = loading;
  $('#refreshInventory').disabled = loading;
  $('#refreshInventory i').classList.toggle('spin', loading);
}

function renderInventoryMetrics(data) {
  $('#inventoryActiveItems').textContent = data.active_items.toLocaleString('en-IN');
  $('#inventoryLowStock').textContent = data.low_stock.toLocaleString('en-IN');
  $('#inventoryOutOfStock').textContent = data.out_of_stock.toLocaleString('en-IN');
  $('#inventoryMovementsToday').textContent = data.movements_today.toLocaleString('en-IN');
}

function renderInventoryLookups(lookups) {
  inventoryState.lookups = lookups;
  const branchSelect = $('#inventoryBranchSelect');
  const currentBranch = branchSelect.value || currentUser?.branch_id || '';
  branchSelect.innerHTML = `${currentUser?.branch_id ? '' : '<option value="">All branches</option>'}${lookups.branches.map((branch) => `<option value="${escapeHtml(branch.id)}">${escapeHtml(branch.name)}</option>`).join('')}`;
  branchSelect.value = currentBranch;
  branchSelect.disabled = Boolean(currentUser?.branch_id);
  const branchId = inventoryBranchId();
  const categories = lookups.categories.filter((category) => !branchId || category.branch_id === branchId);
  const locations = lookups.locations.filter((location) => !branchId || location.branch_id === branchId);
  const items = lookups.items.filter((item) => !branchId || item.branch_id === branchId);
  $('#itemCategory').innerHTML = `<option value="">Select category</option>${categories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join('')}`;
  const locationOptions = locations.map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name)}</option>`).join('');
  $('#movementLocation').innerHTML = `<option value="">Select location</option>${locationOptions}`;
  $('#movementDestination').innerHTML = `<option value="">Select destination</option>${locationOptions}`;
  $('#movementItem').innerHTML = `<option value="">Select item</option>${items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.sku)}</option>`).join('')}`;
  const disableWrites = !canWriteInventory();
  $$('[data-inventory-action="item"], [data-inventory-action="movement"], [data-inventory-action="setup"]').forEach((button) => {
    button.disabled = disableWrites;
    button.title = disableWrites ? 'Your role has read-only inventory access' : '';
  });
}

function renderInventoryItems(data) {
  inventoryState.items = data.items;
  inventoryState.total = data.total;
  const body = $('#inventoryItemsBody');
  if (!data.items.length) {
    body.innerHTML = '<tr class="table-state-row"><td colspan="6"><div class="table-state"><span><i class="bi bi-box-seam"></i></span><strong>No matching inventory items</strong><p>Add the first item or change the search and stock filters.</p></div></td></tr>';
  } else {
    body.innerHTML = data.items.map((item) => {
      const statusLabels = { healthy: 'Healthy', low: 'Low stock', out: 'Out of stock' };
      const location = item.location_names?.length ? item.location_names.join(', ') : 'Not stocked';
      return `<tr><td><div class="item-cell"><span>${escapeHtml(item.name.slice(0, 1).toUpperCase())}</span><p><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.sku)}</small></p></div></td><td>${escapeHtml(item.category_name || 'Uncategorized')}</td><td>${escapeHtml(location)}</td><td class="numeric"><strong>${Number(item.quantity_on_hand).toLocaleString('en-IN', { maximumFractionDigits: 3 })}</strong> ${escapeHtml(item.unit)}</td><td><span class="stock-badge ${escapeHtml(item.stock_status)}">${statusLabels[item.stock_status]}</span></td><td><button class="row-action" data-edit-item="${escapeHtml(item.id)}" aria-label="Edit ${escapeHtml(item.name)}"><i class="bi bi-three-dots"></i></button></td></tr>`;
    }).join('');
  }
  $('#inventoryResultCount').textContent = `${data.total.toLocaleString('en-IN')} item${data.total === 1 ? '' : 's'}`;
  const totalPages = Math.max(1, Math.ceil(data.total / inventoryState.pageSize));
  $('#inventoryPageLabel').textContent = `Page ${inventoryState.page} of ${totalPages}`;
  $('#inventoryPrev').disabled = inventoryState.page <= 1;
  $('#inventoryNext').disabled = inventoryState.page >= totalPages;
}

function renderLowStock(items) {
  const list = $('#inventoryLowStockList');
  if (!items.length) {
    list.innerHTML = '<div class="mini-empty"><i class="bi bi-check2-circle"></i><strong>Stock levels look healthy</strong><span>No low-stock items in this view.</span></div>';
    return;
  }
  list.innerHTML = items.slice(0, 5).map((item) => `<button class="attention-item" type="button" data-filter-item="${escapeHtml(item.name)}"><span class="attention-dot ${escapeHtml(item.stock_status)}"></span><p><strong>${escapeHtml(item.name)}</strong><small>${Number(item.quantity_on_hand).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${escapeHtml(item.unit)} remaining</small></p><i class="bi bi-chevron-right"></i></button>`).join('');
}

function renderMovements(data) {
  const list = $('#inventoryMovementList');
  if (!data.movements.length) {
    list.innerHTML = '<div class="mini-empty"><i class="bi bi-clock-history"></i><strong>No movements yet</strong><span>Receipts, issues, transfers, and adjustments appear here.</span></div>';
    return;
  }
  const incoming = new Set(['opening_balance', 'receipt', 'return_in', 'transfer_in', 'adjustment_gain']);
  list.innerHTML = data.movements.slice(0, 6).map((movement) => {
    const positive = incoming.has(movement.movement_type);
    const time = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(movement.posted_at));
    return `<div class="movement-item"><span class="movement-direction ${positive ? 'in' : 'out'}"><i class="bi bi-arrow-${positive ? 'down-left' : 'up-right'}"></i></span><p><strong>${escapeHtml(movement.item_name || 'Inventory item')}</strong><small>${escapeHtml(movement.location_name || 'Location')} · ${escapeHtml(time)}</small></p><em class="${positive ? 'positive' : 'negative'}">${positive ? '+' : '-'}${Number(movement.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })}</em></div>`;
  }).join('');
}

async function loadInventory({ keepLookups = false } = {}) {
  if (inventoryState.loading || !session?.access_token) return;
  setInventoryLoading(true);
  try {
    const requests = [
      apiRequest(inventoryPath('/dashboard')),
      apiRequest(inventoryPath('/items', { search: inventoryState.search, stock_status: inventoryState.stockStatus, page: inventoryState.page, page_size: inventoryState.pageSize })),
      apiRequest(inventoryPath('/movements', { limit: 12 })),
      apiRequest(inventoryPath('/items', { stock_status: 'low', page: 1, page_size: 5 })),
    ];
    if (!keepLookups || !inventoryState.lookups) requests.push(apiRequest(inventoryPath('/lookups')));
    const [dashboard, items, movements, attention, lookups] = await Promise.all(requests);
    if (lookups) renderInventoryLookups(lookups);
    renderInventoryMetrics(dashboard);
    renderInventoryItems(items);
    renderMovements(movements);
    renderLowStock(attention.items);
  } catch (error) {
    showToast(error.message, 'error');
    $('#inventoryItemsBody').innerHTML = `<tr class="table-state-row"><td colspan="6"><div class="table-state error-state"><span><i class="bi bi-exclamation-triangle"></i></span><strong>Inventory could not be loaded</strong><p>${escapeHtml(error.message)}.</p></div></td></tr>`;
  } finally { setInventoryLoading(false); }
}

function selectedWriteBranch() {
  const branchId = inventoryBranchId();
  if (!branchId) throw new Error('Select a branch before changing inventory');
  return branchId;
}

function setFormError(selector, message = '') {
  const element = $(selector);
  element.textContent = message;
  element.classList.toggle('hidden', !message);
}

function setFormBusy(form, busy) {
  form.querySelectorAll('button, input, select, textarea').forEach((control) => { control.disabled = busy; });
}

function syncMovementFields() {
  const isTransfer = $('#movementType').value === 'transfer';
  $('#movementLocationLabel').textContent = isTransfer ? 'Source location' : 'Location';
  $('#movementDestinationField').classList.toggle('hidden', !isTransfer);
  $('#movementDestination').required = isTransfer;
  $('#movementUnitCostField').classList.toggle('hidden', isTransfer);
  $('#movementUnitCost').disabled = isTransfer;
  if (!isTransfer) $('#movementDestination').value = '';
}

async function refreshLookups() {
  renderInventoryLookups(await apiRequest(inventoryPath('/lookups')));
}

$('#movementType').addEventListener('change', syncMovementFields);
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));

$$('[data-inventory-action]').forEach((button) => button.addEventListener('click', async () => {
  const action = button.dataset.inventoryAction;
  try {
    if (action === 'export') return exportInventory();
    if (!canWriteInventory()) throw new Error('Your role has read-only inventory access');
    selectedWriteBranch();
    if (!inventoryState.lookups) await refreshLookups();
    if (action === 'setup') return $('#inventorySetupDialog').showModal();
    if (action === 'item') {
      $('#inventoryItemForm').reset(); $('#inventoryItemId').value = ''; $('#inventoryItemDialogTitle').textContent = 'Add inventory item'; $('#itemSku').disabled = false; setFormError('#inventoryItemError');
      return $('#inventoryItemDialog').showModal();
    }
    if (action === 'movement') {
      $('#inventoryMovementForm').reset(); setFormError('#inventoryMovementError'); syncMovementFields();
      if ($('#movementItem').options.length === 1) throw new Error('Add an inventory item before recording stock');
      if ($('#movementLocation').options.length === 1) throw new Error('Add a storage location before recording stock');
      return $('#inventoryMovementDialog').showModal();
    }
  } catch (error) { showToast(error.message, 'error'); }
}));

$('#inventoryItemForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; setFormBusy(form, true); setFormError('#inventoryItemError');
  try {
    const itemId = $('#inventoryItemId').value;
    const payload = { category_id: $('#itemCategory').value, name: $('#itemName').value.trim(), description: $('#itemDescription').value.trim() || null, unit: $('#itemUnit').value, reorder_level: Number($('#itemReorderLevel').value), standard_cost: $('#itemStandardCost').value ? Number($('#itemStandardCost').value) : null };
    if (!itemId) { payload.branch_id = selectedWriteBranch(); payload.sku = $('#itemSku').value.trim().toUpperCase(); }
    await apiRequest(itemId ? inventoryPath(`/items/${itemId}`) : '/api/v1/inventory/items', { method: itemId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    $('#inventoryItemDialog').close(); showToast(itemId ? 'Inventory item updated' : 'Inventory item created');
    if (!itemId) inventoryState.lookups = null;
    await loadInventory({ keepLookups: Boolean(itemId) });
  } catch (error) { setFormError('#inventoryItemError', error.message); }
  finally { setFormBusy(form, false); if ($('#inventoryItemId').value) $('#itemSku').disabled = true; }
});

$('#inventoryMovementForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; setFormBusy(form, true); setFormError('#inventoryMovementError');
  try {
    const common = { branch_id: selectedWriteBranch(), item_id: $('#movementItem').value, quantity: Number($('#movementQuantity').value), reference: $('#movementReference').value.trim() || null, notes: $('#movementNotes').value.trim() || null, idempotency_key: crypto.randomUUID() };
    const isTransfer = $('#movementType').value === 'transfer';
    let endpoint = '/api/v1/inventory/movements';
    let payload;
    if (isTransfer) {
      if ($('#movementLocation').value === $('#movementDestination').value) throw new Error('Choose a different destination location');
      endpoint = '/api/v1/inventory/transfers';
      payload = { ...common, from_location_id: $('#movementLocation').value, to_location_id: $('#movementDestination').value };
    } else {
      payload = { ...common, location_id: $('#movementLocation').value, movement_type: $('#movementType').value, unit_cost: $('#movementUnitCost').value ? Number($('#movementUnitCost').value) : null };
    }
    await apiRequest(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    $('#inventoryMovementDialog').close(); showToast(isTransfer ? 'Stock transferred' : 'Stock movement posted');
    await loadInventory({ keepLookups: true });
  } catch (error) { setFormError('#inventoryMovementError', error.message); }
  finally { setFormBusy(form, false); }
});

$('#inventoryCategoryForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; setFormBusy(form, true); setFormError('#inventorySetupError');
  try { await apiRequest('/api/v1/inventory/categories', { method: 'POST', body: JSON.stringify({ branch_id: selectedWriteBranch(), name: $('#categoryName').value.trim(), code: $('#categoryCode').value.trim().toUpperCase() }) }); form.reset(); await refreshLookups(); showToast('Category added'); }
  catch (error) { setFormError('#inventorySetupError', error.message); } finally { setFormBusy(form, false); }
});

$('#inventoryLocationForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; setFormBusy(form, true); setFormError('#inventorySetupError');
  try { await apiRequest('/api/v1/inventory/locations', { method: 'POST', body: JSON.stringify({ branch_id: selectedWriteBranch(), name: $('#locationName').value.trim(), code: $('#locationCode').value.trim().toUpperCase(), location_type: $('#locationType').value }) }); form.reset(); await refreshLookups(); showToast('Storage location added'); }
  catch (error) { setFormError('#inventorySetupError', error.message); } finally { setFormBusy(form, false); }
});

$('#inventoryItemsBody').addEventListener('click', (event) => {
  const button = event.target.closest('[data-edit-item]'); if (!button || !canWriteInventory()) return;
  const item = inventoryState.items.find((candidate) => candidate.id === button.dataset.editItem); if (!item) return;
  $('#inventoryItemForm').reset(); $('#inventoryItemId').value = item.id; $('#inventoryItemDialogTitle').textContent = 'Edit inventory item'; $('#itemName').value = item.name; $('#itemSku').value = item.sku; $('#itemSku').disabled = true; $('#itemCategory').value = item.category_id; $('#itemUnit').value = item.unit; $('#itemReorderLevel').value = item.reorder_level; $('#itemStandardCost').value = item.standard_cost || ''; $('#itemDescription').value = item.description || ''; setFormError('#inventoryItemError'); $('#inventoryItemDialog').showModal();
});

async function exportInventory() {
  try {
    const exported = []; let page = 1; let total = 0;
    do { const result = await apiRequest(inventoryPath('/items', { search: inventoryState.search, stock_status: inventoryState.stockStatus, page, page_size: 100 })); exported.push(...result.items); total = result.total; page += 1; } while (exported.length < total);
    if (!exported.length) return showToast('There are no inventory items to export');
    const rows = [['SKU', 'Item', 'Category', 'Locations', 'Quantity', 'Unit', 'Status'], ...exported.map((item) => [item.sku, item.name, item.category_name || '', (item.location_names || []).join('; '), item.quantity_on_hand, item.unit, item.stock_status])];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = `octominds-inventory-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href); showToast(`${exported.length.toLocaleString('en-IN')} inventory items exported`);
  } catch (error) { showToast(error.message, 'error'); }
}

let inventorySearchTimer;
$('#inventorySearch').addEventListener('input', (event) => { clearTimeout(inventorySearchTimer); inventorySearchTimer = setTimeout(() => { inventoryState.search = event.target.value.trim(); inventoryState.page = 1; loadInventory({ keepLookups: true }); }, 320); });
$('#inventoryStockFilter').addEventListener('change', (event) => { inventoryState.stockStatus = event.target.value; inventoryState.page = 1; loadInventory({ keepLookups: true }); });
$('#inventoryBranchSelect').addEventListener('change', () => { inventoryState.page = 1; inventoryState.lookups = null; $('#topbarBranch').textContent = $('#inventoryBranchSelect').selectedOptions[0]?.textContent || 'All branches'; loadInventory(); });
$('#inventoryPrev').addEventListener('click', () => { inventoryState.page -= 1; loadInventory({ keepLookups: true }); });
$('#inventoryNext').addEventListener('click', () => { inventoryState.page += 1; loadInventory({ keepLookups: true }); });
$('#refreshInventory').addEventListener('click', () => loadInventory());
$('#viewLowStock').addEventListener('click', () => { $('#inventoryStockFilter').value = 'low'; inventoryState.stockStatus = 'low'; inventoryState.page = 1; loadInventory({ keepLookups: true }); });
$('#inventoryLowStockList').addEventListener('click', (event) => { const item = event.target.closest('[data-filter-item]'); if (!item) return; $('#inventorySearch').value = item.dataset.filterItem; inventoryState.search = item.dataset.filterItem; loadInventory({ keepLookups: true }); });

if (!configured()) $('#configurationNotice').classList.remove('hidden');
restoreSession();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
