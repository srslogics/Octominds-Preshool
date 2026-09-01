import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("inventory workspace contains the production workflows", async () => {
  const [html, javascript, css] = await Promise.all([
    source("public/index.html"),
    source("public/app.js"),
    source("public/styles.css"),
  ]);

  for (const marker of [
    'id="inventoryPage"',
    'class="app-header"',
    'class="inventory-hero"',
    'id="inventoryItemForm"',
    'id="inventoryMovementForm"',
    'id="inventoryCenterForm"',
    'id="inventoryOnboarding"',
    'id="onboardingAction"',
    'class="quick-actions"',
    'data-stock-action="receipt"',
    'data-stock-action="issue"',
    'data-stock-action="transfer"',
    'id="itemOpeningStock"',
    'id="movementDialogTitle"',
    'id="centerSetupSummary"',
    'id="movementDestination"',
    'id="inventoryCategoryForm"',
    'id="inventoryLocationForm"',
    'id="inventoryItemsBody"',
  ]) assert.match(html, new RegExp(marker));

  for (const removedModule of ["Admissions", "Students", "Academics", "Fees", "Daycare", "Reports"]) {
    assert.doesNotMatch(html, new RegExp(`data-view=["']${removedModule}`, "i"));
  }

  for (const behavior of [
    "loadInventory",
    "idempotency_key",
    "exportInventory",
    "canWriteInventory",
    "inventoryStockFilter",
    "inventory/transfers",
    "inventory/centers",
    "updateGuidance",
    "routeInventoryAction",
    "openMovementDialog",
    "itemOpeningQuantity",
    "data-stock-item",
    "inventory-data-row",
    "lookups.branches.length === 1",
    "exported.length < total",
  ]) assert.match(javascript, new RegExp(behavior));

  assert.match(css, /\.inventory-layout/);
  assert.match(css, /\.quick-actions/);
  assert.match(css, /\.movement-choice/);
  assert.match(css, /\.app-header/);
  assert.match(css, /\.inventory-hero/);
  assert.match(css, /attr\(data-label\)/);
  assert.match(css, /\.app-dialog::backdrop/);
  assert.match(css, /@media \(max-width: 440px\)/);
});

test("inventory migration protects integrity and branch access", async () => {
  const sql = await source("supabase/migrations/202608290001_inventory_production.sql");
  for (const invariant of [
    "inventory_movements_immutable",
    "inventory_stock_nonnegative",
    "inventory_movement_idempotency_unique",
    "has_inventory_access",
    "post_inventory_movement",
    "for update",
    "insufficient_stock",
    "opening_balance_already_exists",
    "inventory.movement_posted",
    "transfer_inventory_stock",
    "inventory.stock_transferred",
    "transfer_group_id",
  ]) assert.match(sql, new RegExp(invariant.replaceAll(".", "\\."), "i"));

  assert.doesNotMatch(sql, /grant\s+(update|delete)[^;]*inventory_movements/i);
  assert.match(sql, /enable row level security/gi);
});

test("center onboarding is protected and available inside inventory", async () => {
  const [sql, router, html] = await Promise.all([
    source("supabase/migrations/202609010001_inventory_center_setup.sql"),
    source("api/inventory/router.py"),
    source("public/index.html"),
  ]);
  assert.match(sql, /create_inventory_center/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /super_admin.*management/is);
  assert.match(sql, /grant execute.*authenticated/is);
  assert.match(sql, /revoke all.*anon/is);
  assert.match(router, /@router\.post\("\/centers"/);
  assert.match(router, /Role\.SUPER_ADMIN/);
  assert.match(html, /Create.*center/i);
  assert.match(html, /multi-center stock control/i);
});

test("inventory API exposes versioned endpoints behind current-user access", async () => {
  const [router, permissions, main, config] = await Promise.all([
    source("api/inventory/router.py"),
    source("api/inventory/permissions.py"),
    source("api/main.py"),
    source("api/config.py"),
  ]);
  assert.match(router, /prefix="\/api\/v1\/inventory"/);
  assert.match(router, /Depends\(get_current_user\)/);
  assert.match(router, /@router\.post\("\/movements"/);
  assert.match(router, /@router\.post\("\/transfers"/);
  assert.match(permissions, /INVENTORY_WRITE_ROLES/);
  assert.match(permissions, /Requested center is outside your access/);
  assert.match(main, /include_router\(inventory_router\)/);
  assert.match(router, /response_model=LookupResponse/);
  assert.match(config, /SUPABASE_ANON_KEY is required in production/);
  assert.doesNotMatch(config, /use_confirmed_supabase_project/);
});

test("service worker never caches authenticated API data", async () => {
  const serviceWorker = await source("public/sw.js");
  assert.match(serviceWorker, /octominds-inventory-v6/);
  assert.match(serviceWorker, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(serviceWorker, /url\.origin !== self\.location\.origin/);
  assert.doesNotMatch(serviceWorker.match(/const SHELL = \[[^\]]+\]/)?.[0] ?? "", /config\.js/);
});
