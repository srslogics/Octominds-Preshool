# OctoMinds Preschool Operations

School setup, account access and multi-center inventory for OctoMinds preschool operations.

Modules 1 and 2 are available at `/school`. See [school setup and access release notes](docs/school-foundation-access.md) for capabilities, permissions, staging prerequisites and verification. Legacy `/school.html` links redirect to `/school`.

Production sign-off is pending. See `docs/audits/2026-10-11-inventory-audit.md` for confirmed findings, locally implemented fixes, and remaining checks.

## Family portal

The first parent portal is available at `/parents`. Explore `/parents?preview=1` for a clearly labelled, memory-only preview with parent and school-team views. Preview actions never call the live API.

Linked families can switch children, read class notices, home learning and diary notes, view dated events and school holidays, and message the assigned school team. Administrators register children and link accepted parent accounts from the School desk. Assigned teachers publish updates and private photo albums for their current classes. See [parent portal setup and release notes](docs/parent-portal.md) before enabling live use.


## Workspace screens

The signed-in application has bookmarkable hash routes: `/#/overview`, `/#/items`, `/#/items/<id>`, `/#/movements`, `/#/transfers`, `/#/centers`, `/#/reports`, and `/#/settings`. Browser back/forward and refresh preserve the requested screen. Authentication is still required for all data.

Movement history supports server-side pagination and type filtering. Transfers are between locations within one center, not between centers. Reports currently provide stock-balance CSV exports; account settings display assigned access, with PIN administration remaining an administrator task. Creation/editing uses focused forms opened from its relevant screen.

Run `tests/inventory-pages.cjs` with Playwright, axe-core, a local static server, `TEST_APP_ORIGIN`, and `CHROME_PATH` as needed. Tests use synthetic API data, never live stock writes.

## Capabilities

- School accounts with email/password or mobile number and PIN sign-in
- Role and center access for Super Admin, Management, Center Admin, and Accountant
- Center onboarding inside Inventory Setup
- Center-wise categories, storage locations, and item catalogue
- Opening balances, receipts, issues, returns, and adjustments
- Atomic transfers between locations
- Live stock balances and weighted average cost
- Low-stock and out-of-stock monitoring
- Immutable movement ledger, idempotency, and audit events
- Search, pagination, responsive UI, and filtered CSV export
- FastAPI, Turso persistence, a PWA shell, and Render deployment configuration

## Render and existing data

Use the [Turso migration and Render guide](docs/turso-migration.md) to prepare a verified snapshot from the existing backup, import it into Turso, and configure Render. The older Supabase migrations remain in the repository to support backup restoration and migration rehearsals.

## Run locally

Use Python 3.13 (matching Render) and Node.js 22 for the local checks. From the repository root:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
cp .env.example .env
```

Local development uses `.local/octominds.db` by default. To sign in locally, create the first owner before launching the service.

```sh
python -m scripts.turso_admin owner --email owner@example.test --name "Test Owner"
python -m uvicorn api.main:app --reload --host 127.0.0.1 --port 8000
```

Inventory is at `/`, school administration at `/school`, and the family portal at `/parents`. The family preview at `/parents?preview=1` uses sample data. `/health` checks whether the process is running, and `/ready` checks database connectivity and schema.

## Verify

```text
npm test
python3 -m compileall -q api
python3 -m unittest discover -s tests -p 'test_*.py'
```

GitHub Actions runs JavaScript checks, Python integration tests with a temporary SQLite database, and the parent and gallery browser suites. To rehearse a Supabase backup import with synthetic data, follow the [migration guide](docs/turso-migration.md).

Detailed inventory design history is in [Inventory system design](docs/inventory-system-design.md).
