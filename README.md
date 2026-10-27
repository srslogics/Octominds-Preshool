# OctoMinds Preschool Operations

School setup, account access and multi-center inventory for OctoMinds preschool operations.

Modules 1 and 2 are available at `/school`. See [school setup and access release notes](docs/school-foundation-access.md) for capabilities, permissions, staging prerequisites and verification. Legacy `/school.html` links redirect to `/school`.

Production sign-off is pending. See `docs/audits/2026-10-11-inventory-audit.md` for confirmed findings, locally implemented fixes, and remaining checks.

## Included

## Workspace screens

The signed-in application has bookmarkable hash routes: `/#/overview`, `/#/items`, `/#/items/<id>`, `/#/movements`, `/#/transfers`, `/#/centers`, `/#/reports`, and `/#/settings`. Browser back/forward and refresh preserve the requested screen. Authentication is still required for all data.

Movement history supports server-side pagination and type filtering. Transfers are between locations within one center, not between centers. Reports currently provide stock-balance CSV exports; account settings display assigned access, with PIN administration remaining an administrator task. Creation/editing uses focused forms opened from its relevant screen.

Run `tests/inventory-pages.cjs` with Playwright, axe-core, a local static server, `TEST_APP_ORIGIN`, and `CHROME_PATH` as needed. Tests use synthetic API data, never live stock writes.

## Capabilities

- Secure mobile-number and PIN sign-in through Supabase Auth
- Role and center access for Super Admin, Management, Center Admin, and Accountant
- Center onboarding inside Inventory Setup
- Center-wise categories, storage locations, and item catalogue
- Opening balances, receipts, issues, returns, and adjustments
- Atomic transfers between locations
- Live stock balances and weighted average cost
- Low-stock and out-of-stock monitoring
- Immutable movement ledger, idempotency, and audit events
- Search, pagination, responsive UI, and filtered CSV export
- FastAPI API, Supabase PostgreSQL/RLS, PWA shell, and Render deployment configuration

## Production setup

Apply the migrations in order to the Supabase project configured by `SUPABASE_URL`:

1. `supabase/migrations/202608160001_phase_1_foundation.sql`
2. `supabase/migrations/202608290001_inventory_production.sql`
3. `supabase/migrations/202609010001_inventory_center_setup.sql`
4. `supabase/migrations/202610110001_inventory_access_hardening.sql`
5. `supabase/migrations/202610110002_inventory_stock_integrity.sql`
6. `supabase/migrations/202610130001_inventory_reporting.sql`
7. `supabase/migrations/202610260001_school_foundation.sql`

Create approved users and memberships after the foundation migration. Browser-safe Supabase configuration is served dynamically by FastAPI at `/config.js`; database credentials and JWT secrets remain in Render environment variables.

Required Render variables:

- `ENVIRONMENT=production`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_JWT_SECRET` when the project uses HS256 tokens
- `DATABASE_URL`
- `FRONTEND_ORIGIN`

## Run locally

Install Python packages from `requirements.txt`, provide a local `.env`, then start:

```text
uvicorn api.main:app --reload
```

The application is served from the FastAPI origin. The standalone frontend preview command is available as `npm run dev` for layout work only.

## Verify

```text
npm test
python3 -m compileall -q api
python3 -m unittest discover -s tests -p 'test_*.py'
```

Behavioral regression tests added during the October audit:

- `tests/inventory-security-regression.py`: requires `psycopg2-binary` and an **empty disposable local PostgreSQL database** named `test_*`. Supply its URL through `TEST_DATABASE_URL`. The script installs test auth scaffolding and all migrations; it deliberately refuses remote/non-test targets. Never use a live database.
- `tests/inventory-browser-regressions.cjs`: requires Playwright and a local server serving `public/`. Set `TEST_APP_ORIGIN` (default `http://127.0.0.1:4179`) and optionally `CHROME_PATH`. All authentication/API responses are synthetic, not live Supabase calls. Run with `node tests/inventory-browser-regressions.cjs`.
- `tests/test_inventory_api_regressions.py`: normal unittest discovery above, with the application's Python dependencies installed.

The stock-integrity migration adds finite-cost constraints as `NOT VALID` to preserve existing records. It enforces them on new/updated rows. Before production sign-off, inspect any existing non-finite costs, resolve them through an approved data-correction process, and validate `inventory_standard_cost_finite` and `inventory_average_cost_finite`. Do not silently reset historical amounts.

## Release order

1. Back up Supabase.
2. Apply all pending migrations in order to staging and complete acceptance testing.
3. Apply the same pending migrations to production; do not rerun the foundation on an existing database.
4. Deploy the Render service.
5. Create centers, categories, and locations from Inventory Setup.
6. Import the item catalogue and post verified opening balances.

Detailed module architecture is in `docs/inventory-system-design.md`.
