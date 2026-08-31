# OctoMinds Inventory

Production inventory control for OctoMinds preschool branches.

## Included

- Secure mobile-number and PIN sign-in through Supabase Auth
- Role and branch access for Super Admin, Management, Branch Admin, and Accountant
- Branch-wise categories, storage locations, and item catalogue
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
```

## Release order

1. Back up Supabase.
2. Apply both migrations to staging and complete acceptance testing.
3. Apply the inventory migration to production.
4. Deploy the Render service.
5. Create categories and locations for each branch.
6. Import the item catalogue and post verified opening balances.

Detailed module architecture is in `docs/inventory-system-design.md`.
