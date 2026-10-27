/* Route-level screens. Hash URLs work on Render and on installed PWAs. */
const screens = {
  overview: ['Overview', 'Stock health and recent activity across your centers.'],
  items: ['Items', 'Browse your catalogue, balances, and item details.'],
  movements: ['Stock movements', 'Receipts, issues, returns, and stock corrections.'],
  transfers: ['Transfers', 'Move stock between storage locations within a center.'],
  centers: ['Centers & storage', 'Manage centers, categories, and storage locations.'],
  reports: ['Reports', 'Download stock balances for the selected center.'],
  settings: ['Account', 'Your signed-in identity and assigned access.'],
};
const icons = ['grid-1x2', 'box-seam', 'clock-history', 'arrow-left-right', 'buildings', 'download', 'person-circle'];
const pageHost = document.createElement('div');
pageHost.id = 'routeContent';
$('#inventoryPage').append(pageHost);
const routeState = { version: 0, offset: 0, type: 'all' };
const nav = $('.workspace-nav');
nav.innerHTML = Object.entries(screens).map(([id, [name]], i) => `<a href="#/${id}" data-page="${id}"><i class="bi bi-${icons[i]}" aria-hidden="true"></i>${name}</a>`).join('');
nav.insertAdjacentHTML('beforeend', '<a href="/school"><i class="bi bi-building-gear" aria-hidden="true"></i>School administration</a>');
$('.rail-management').remove();
$$('.rail-brand, .app-brand').forEach(link => { link.href = '#/overview'; });
$('.inventory-heading h1').tabIndex = -1;
$('.quick-actions').classList.add('hidden');
const pageToolbar = document.createElement('div');
pageToolbar.className = 'page-toolbar';
$('.inventory-hero').append(pageToolbar);
const overviewIntro = document.createElement('section');
overviewIntro.className = 'overview-intro hidden';
overviewIntro.setAttribute('aria-label', 'Inventory shortcuts');
$('.inventory-hero').after(overviewIntro);

function routeInfo() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/');
  return { page: parts[0] || 'overview', itemId: parts[1], query: new URLSearchParams(query) };
}
function navigatePage(page) { location.hash = `/${page}`; }
function routeButton(label, action, type = 'action') {
  return `<button class="secondary-button" type="button" data-page-${type}="${action}">${label}</button>`;
}
function pageError(error) {
  pageHost.innerHTML = `<section class="card route-message" role="alert"><h2>Unable to load this screen</h2><p>${escapeHtml(error.message)}</p>${routeButton('Try again', 'retry')}</section>`;
}
function setupReadOnly() {
  const lookups = inventoryState.lookups || { branches: [], categories: [], locations: [] };
  return ['branches', 'categories', 'locations'].map((key, index) => `<section class="card directory"><h2>${['Centers', 'Categories', 'Storage locations'][index]}</h2>${lookups[key].length ? `<ul>${lookups[key].map(row => `<li><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(row.code || '')}</span></li>`).join('')}</ul>` : '<p>No records yet.</p>'}</section>`).join('');
}
async function renderRoute({ focus = false } = {}) {
  const version = ++routeState.version;
  if (!currentUser) return;
  const route = routeInfo();
  const known = Boolean(screens[route.page]);
  const [title, subtitle] = screens[route.page] || ['Page not found', 'Choose a screen from the navigation.'];
  document.title = `${title} · OctoMinds Inventory`;
  $('.inventory-heading h1').textContent = title;
  $('.inventory-heading .muted').textContent = subtitle;
  $('.workspace-breadcrumb strong').textContent = title;
  nav.querySelectorAll('a').forEach(a => {
    const active = a.dataset.page === route.page;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const overview = route.page === 'overview';
  overviewIntro.classList.toggle('hidden', !overview);
  if (overview) {
    overviewIntro.innerHTML = `<div><p class="eyebrow">A LITTLE ORDER. A BETTER DAY.</p><h2>Every center, thoughtfully stocked.</h2><p>Know what’s available, see what needs attention, and keep the day moving.</p></div><div class="overview-intro-actions"><a class="secondary-button" href="#/items">Explore catalogue <i class="bi bi-arrow-up-right" aria-hidden="true"></i></a><a class="secondary-button" href="#/movements">Stock movements <i class="bi bi-arrow-right" aria-hidden="true"></i></a></div>`;
  }
  $('.inventory-metrics').classList.toggle('hidden', !overview);
  $('.inventory-side-stack').classList.toggle('hidden', !overview);
  $('#stockCatalogue').classList.toggle('hidden', route.page !== 'items' || Boolean(route.itemId));
  $('#inventoryOnboarding').classList.toggle('route-hidden', !overview);
  $('.inventory-layout').classList.toggle('hidden', !overview && (route.page !== 'items' || Boolean(route.itemId)));
  pageToolbar.innerHTML = '';
  pageHost.innerHTML = '';
  if (focus) { $('.inventory-heading h1').focus(); window.scrollTo(0, 0); }
  if (!known) { pageHost.innerHTML = '<p><a href="#/overview">Return to overview</a></p>'; return; }
  if (route.page === 'centers' && !inventoryState.lookups) { pageHost.innerHTML = '<p role="status">Loading centers and storage…</p>'; return; }
  const writable = canWriteInventory();
  if (route.page === 'items') pageToolbar.innerHTML = writable ? routeButton('New item', 'item') : '';
  if (route.page === 'movements' && writable) pageToolbar.innerHTML = routeButton('Receive stock', 'receipt', 'stock') + routeButton('Issue stock', 'issue', 'stock') + routeButton('Correct / return stock', 'adjustment_gain', 'stock');
  if (route.page === 'transfers' && writable) pageToolbar.innerHTML = routeButton('New transfer', 'transfer', 'stock');
  try {
    if (['movements', 'transfers'].includes(route.page)) {
      pageHost.innerHTML = '<p role="status">Loading stock history…</p>';
      const type = route.page === 'transfers' ? 'transfer' : routeState.type;
      const data = await apiRequest(inventoryPath('/movements', { limit: 25, offset: routeState.offset, movement_type: type }));
      if (version !== routeState.version || !currentUser) return;
      const types = {all:'All movements',receipt:'Received',issue:'Issued',return_in:'Returned',adjustment_gain:'Adjustment gain',adjustment_loss:'Adjustment loss',opening_balance:'Opening balance'};
      pageHost.innerHTML = `<section class="card"><div class="card-head"><h2>${route.page === 'transfers' ? 'Transfer ledger' : 'Movement history'}</h2>${route.page === 'movements' ? `<label>Type <select id="historyType">${Object.entries(types).map(([key,label])=>`<option value="${key}" ${key===type?'selected':''}>${label}</option>`).join('')}</select></label>` : '<p>Each transfer has an outgoing and an incoming entry.</p>'}</div><div class="inventory-table-wrap"><table class="history-table"><thead><tr><th>Posted</th><th>Item</th><th>Type</th><th>Location</th><th>Quantity</th><th>Reference / notes</th></tr></thead><tbody>${data.movements.map(row => `<tr><td>${escapeHtml(new Date(row.posted_at).toLocaleString('en-IN'))}</td><td>${escapeHtml(row.item_name)}<small>${escapeHtml(row.sku)}</small></td><td>${escapeHtml(row.movement_type.replaceAll('_',' '))}</td><td>${escapeHtml(row.location_name)}</td><td>${escapeHtml(row.signed_quantity ?? row.quantity)} ${escapeHtml(row.unit)}</td><td>${escapeHtml(row.reference || '—')}<small>${escapeHtml(row.notes || '')}</small></td></tr>`).join('') || '<tr><td colspan="6">No movements match this view.</td></tr>'}</tbody></table></div><div class="inventory-pagination"><span>${data.total} entries</span><div><button class="secondary-button" data-history-page="-1" ${routeState.offset===0?'disabled':''}>Previous</button><span>Page ${routeState.offset / 25 + 1}</span><button class="secondary-button" data-history-page="1" ${routeState.offset+25>=data.total?'disabled':''}>Next</button></div></div></section>`;
    } else if (route.page === 'centers') {
      pageHost.innerHTML = `<div class="directory-grid">${setupReadOnly()}</div>${writable ? routeButton('Add center, category or location', 'setup') : '<p>Your account has read-only access.</p>'}`;
    } else if (route.page === 'reports') {
      pageHost.innerHTML = `<section class="card route-message"><h2>Stock balance export</h2><p>CSV with item codes, names, categories, locations, quantities, units, and stock status. Uses the center selected above.</p><label class="field">Stock status<select id="reportStatus"><option value="all">All stock</option><option value="low">Low stock</option><option value="out">Out of stock</option><option value="healthy">Healthy stock</option></select></label>${routeButton('Download CSV', 'report')}</section>`;
    } else if (route.page === 'settings') {
      pageHost.innerHTML = `<section class="card route-message"><h2>Account & access</h2><dl><dt>Name</dt><dd>${escapeHtml(currentUser.full_name)}</dd><dt>Role</dt><dd>${escapeHtml(currentUser.role_label || currentUser.role)}</dd><dt>Center access</dt><dd>${escapeHtml(currentUser.branch_name || 'All authorized centers')}</dd></dl><p>Contact an authorized administrator to change your PIN or access.</p>${routeButton('Sign out', 'logout')}</section>`;
    } else if (route.page === 'items' && route.itemId) {
      pageHost.innerHTML = '<p role="status">Loading item…</p>';
      const item = await apiRequest(inventoryPath(`/items/${encodeURIComponent(route.itemId)}`));
      if (version !== routeState.version || !currentUser) return;
      pageHost.innerHTML = `<section class="card route-message"><a href="#/items">← Back to items</a><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.sku)} · ${escapeHtml(item.category_name)}</p><dl><dt>On hand</dt><dd>${escapeHtml(item.quantity_on_hand)} ${escapeHtml(item.unit)}</dd><dt>Reorder level</dt><dd>${escapeHtml(item.reorder_level)}</dd><dt>Notes</dt><dd>${escapeHtml(item.description || 'No notes')}</dd></dl><h3>Storage balances</h3><ul>${(item.balances || []).map(b=>`<li>${escapeHtml(b.inventory_locations?.name || 'Location')}: ${escapeHtml(b.quantity_on_hand)} ${escapeHtml(item.unit)}</li>`).join('') || '<li>No stock recorded.</li>'}</ul></section>`;
    }
  } catch (error) { if (version === routeState.version && currentUser) pageError(error); }
}
window.addEventListener('hashchange', () => { routeState.offset = 0; renderRoute({ focus: true }); });
document.addEventListener('click', async event => {
  const action = event.target.closest('[data-page-action]');
  const stock = event.target.closest('[data-page-stock]');
  const pagination = event.target.closest('[data-history-page]');
  if (stock) return openMovementDialog(stock.dataset.pageStock);
  if (pagination) { routeState.offset = Math.max(0, routeState.offset + Number(pagination.dataset.historyPage)*25); return renderRoute(); }
  if (!action) return;
  const name = action.dataset.pageAction;
  if (name === 'retry') return routeInfo().page === 'centers' ? loadInventory() : renderRoute();
  if (name === 'logout') return $('#logoutButton').click();
  if (name === 'report') {
    action.disabled = true;
    try { await exportInventory({ search: '', stockStatus: $('#reportStatus').value }); } finally { action.disabled = false; }
    return;
  }
  routeInventoryAction(name);
});
document.addEventListener('change', event => {
  if (event.target.id === 'historyType') { routeState.type = event.target.value; routeState.offset = 0; renderRoute(); }
});
// Existing stock writes refresh data; refresh the active route after that completes.
document.addEventListener('inventory:loaded', () => renderRoute());
document.addEventListener('inventory:loaded', () => {
  $$('#inventoryItemsBody .item-cell strong').forEach((name, index) => {
    const item = inventoryState.items[index];
    if (item) name.innerHTML = `<a class="item-detail-link" href="#/items/${encodeURIComponent(item.id)}">${escapeHtml(item.name)}</a>`;
  });
});
document.addEventListener('inventory:logout', () => { routeState.version++; pageHost.innerHTML = ''; });
document.addEventListener('inventory:loading', () => {
  routeState.version++;
  if (!['overview', 'items'].includes(routeInfo().page) || routeInfo().itemId) {
    pageHost.innerHTML = '<section class="card route-message" role="status">Loading this view…</section>';
  }
});
document.addEventListener('inventory:error', event => {
  if (!['overview', 'items'].includes(routeInfo().page) || routeInfo().itemId) pageError(new Error(event.detail));
});
document.addEventListener('click', event => {
  if (event.target.closest('[data-stock-filter], #viewLowStock, [data-filter-item]')) navigatePage('items');
  const link = event.target.closest('a[href="#recentActivity"]');
  if (link) { event.preventDefault(); navigatePage('movements'); }
});
restoreSession();
