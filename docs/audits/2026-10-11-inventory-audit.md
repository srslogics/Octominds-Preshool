# OctoMinds inventory: audit and first remediation batch

Date: 11 October 2026

## Executive assessment

The application is not yet ready for production sign-off. The audit found failures in authorization, stock integrity, authentication recovery, multi-center workflows, reporting, accessibility, and deployment readiness. The most urgent live issue is that the configured Supabase hostname did not resolve during the audit. The frontend loading successfully does not establish that the inventory backend is available.

After the audit, the owner requested implementation. The first corrective batch is now implemented locally and tested as described below. Nothing has been pushed, deployed, or applied to the live database in this batch. “Fixed locally” below does not mean the live application is fixed.

## Scope and evidence

- Reviewed frontend JavaScript, HTML, CSS, service worker, authentication, API routes, schemas, repository/service logic, three original SQL migrations, deployment instructions, and existing tests.
- Read-only checks of the deployed site, configuration, health response, API schema, and unauthenticated session endpoint. No customer records were accessed or modified.
- Applied migrations and exercised authorization and inventory commands in disposable PostgreSQL 16 databases, with an emulated Supabase `auth.uid()` and authenticated/anonymous roles.
- Exercised the real frontend in headless Chrome against synthetic API responses: retries, center switching, editing, session expiry, sign-out, read-only accounts, exports, and multiple viewport widths.
- Checked dependency advisories and ran automated accessibility checks. These are not a full penetration test, load test, or assistive-technology assessment.

Evidence labels: **Live** = deployed public service; **DB** = isolated PostgreSQL reproduction; **Browser** = real frontend with synthetic API responses; **Unit** = isolated actual Python logic with mocked upstream responses; **Code** = inspected implementation, not a complete production reproduction.

## Findings register

P0: current availability blocker. P1: serious access-control or stock-integrity risk. P2: functional, operational, or usability defect needing correction before sign-off.

| ID | Priority | Finding and reproduction | First-batch status |
|---|---|---|---|
| A01 | P0 | **Live backend hostname unavailable.** The deployed configuration references `ipzhzxemjflihwbutkjl.supabase.co`. Google and Cloudflare DNS-over-HTTPS returned NXDOMAIN. `/health` nevertheless returned `ok`, with environment `development`. This establishes a dependency/configuration problem, not its underlying cause; project deletion or suspension was not confirmed. | Blocked on restoring/verifying the intended Supabase project and Render configuration. |
| A02 | P1 | **Disabled users can reactivate themselves.** An authenticated user with an inactive profile and active membership could update their own `is_active` to true, then regain inventory access. **DB** | Fixed locally: safe-column-only profile updates. |
| A03 | P1 | **Inventory read policy bypasses API role restrictions.** A teacher or parent could SELECT inventory directly through the database role even though FastAPI/UI disallowed that role. **DB** | Fixed locally: database read-role allowlist matches inventory roles. |
| A04 | P1 | **Retry can duplicate stock.** Abort a movement response, then retry the unchanged form: the browser generated a new command key. A committed first request could therefore be posted twice. **Browser + Code** | Fixed for retrying the same open movement form: stable command key. Closing/recreating a command after an uncertain result still requires reconciliation. |
| A05 | P1 | **Center switch can display stale stock.** Delay a Center A load and switch to Center B: the selector changed but A's rows remained. The item PATCH also discarded the resolved center when filtering the item. **Browser + Code** | Fixed locally: latest-request rendering and center-scoped PATCH. |
| A06 | P1 | **Sign-out retains entered PIN and skips provider logout.** Sign in and sign out without reloading; the PIN remained in the hidden/reopened form. No provider logout request was made. **Browser** | Fixed locally: form/session reset, cross-tab logout signal, provider logout request, and explicit warning if server revocation fails. |
| A07 | P1 | **Unit changes reinterpret existing inventory.** Change an item with 10 pieces to unit box; history and balances then present those quantities as boxes. **DB** | Fixed locally: database rejects unit changes after movement history exists; stock commands coordinate locks with catalogue updates. |
| A08 | P1 | **Archiving can strand positive stock.** Archive an item holding stock; normal lists hide it and subsequent issue commands reject it. API/direct database path, not a visible archive control. **DB** | Fixed locally: archive is blocked while any location has nonzero stock. |
| A09 | P1 | **Dependency set contains known security advisories.** Fresh installation resolved Starlette 0.47.3 under FastAPI 0.116.1; the static-file route is relevant to the Range-header advisory. PyJWT 2.10.1 was also flagged. **Dependency scan + Code** | Pending dependency upgrade and compatibility tests. Exact installed live versions were not confirmed. |
| A10 | P2 | **Open sessions do not renew/recover.** Return 401 after initial login: the old UI stayed open with a generic inventory error, without refresh or sign-in recovery. **Browser** | Fixed locally: shared refresh request, one retry, and safe return to login if renewed credentials are rejected. |
| A11 | P2 | **Cross-center transfer is not implemented.** An A-to-B destination fails because both locations must belong to the same center. The implemented transfer is between locations within one center. **DB + Code** | Pending: design explicit source/destination center authorization and item mapping. Do not label current transfer as cross-center. |
| A12 | P2 | **Multiple memberships are reduced arbitrarily to one.** Authentication requests one membership without ordering; a teacher-first response differs from an admin-first response. Multiple authorized centers are not represented. **Unit + Code** | Pending: explicit scope selection and authoritative membership aggregation. |
| A13 | P2 | **Large catalogues produce truncated metrics and filtered results.** Service logic ignores the database total and computes over one capped response. A fixture returning 1,000 of 1,500 rows reported 1,000. A hard 5,000 requested limit remains even with a larger service cap. **Unit** | Pending database-side aggregates/filtering and stable pagination. Actual production row cap not verified. |
| A14 | P2 | **Reorder watch falsely looks healthy with zero stock.** Dashboard shows one out-of-stock item, but the watch fetches only `low` and displays “Stock levels look healthy.” **Browser** | Pending inclusion of out-of-stock items and consistent drilldown filters. |
| A15 | P2 | **Edit from All centers fails.** Open an item and save with no selected center; the API demands a center. **Browser** | Fixed locally: select and load the item's center before opening edit. |
| A16 | P2 | **Description/cost cannot be cleared.** Explicit null changes were removed before PATCH. **Unit** | Fixed locally: retain null for nullable fields; reject null for required fields. |
| A17 | P2 | **“Today” uses UTC instead of center-local day.** At 01:30 India time the query began at the previous UTC midnight rather than local midnight, including previous-day movements. **Unit** | Pending timezone-aware reporting boundaries. |
| A18 | P2 | **Non-finite costs pass direct database commands.** A numeric `NaN` cost passed the SQL comparison and entered average cost. FastAPI validation alone cannot protect direct RPC access. **DB** | Fixed locally for new commands/updates. Existing rows must be checked and constraints validated before sign-off; no historical amounts were rewritten. |
| A19 | P2 | **Server retry semantics break under concurrency or changed payload.** Simultaneous same-key issue requests could produce success plus insufficient-stock instead of the same result. Reusing a key with changed quantity silently returned the old result. **DB** | Fixed locally: per-command transaction lock and payload consistency checks for movements and transfers. |
| A20 | P2 | **Opening balance can be posted again after draining stock.** Receive, issue back to zero, then post another opening balance. **DB** | Fixed locally: opening is only allowed before the first movement at that item/location. |
| A21 | P2 | **Audit events can be fabricated; no operational audit reader.** An authenticated client could insert an invented event with its own actor ID. Authenticated SELECT returned no audit events. **DB** | Forging fixed locally; usable audit-report/read workflow remains pending. Immutable stock ledger is a separate mechanism. |
| A22 | P2 | **Inactive centers still accept movements.** Deactivate a center and post a receipt: the command succeeded. **DB** | Fixed locally: inventory access requires an active center. |
| A23 | P2 | **Infrastructure errors are mislabeled or unhandled.** Auth connection failures became “Invalid access token”; an HTML gateway error caused JSON decoding failure in the repository. **Unit** | Fixed locally: unavailable-service errors are 503; invalid upstream JSON is handled; browser validation arrays are readable. |
| A24 | P2 | **Read-only accountant receives write controls.** Row-level Update stock opened an enabled movement dialog even though the backend correctly denied writes. **Browser** | Fixed locally: row write controls hidden/disabled, dialog guarded. This was misleading UI, not an API privilege escalation. |
| A25 | P2 | **Reconciliation lacks usable detail.** Catalogue sums location quantities without exposing each location balance; UI shows six recent movements, with no complete searchable history and actor drilldown. **Code** | Pending operational history, location balances, filters, and pagination. |
| A26 | P2 | **Deployment instructions omit required migration.** README listed only two migrations although center creation requires the third. **Code** | Fixed locally: complete ordered list now includes both new corrective migrations. Deployment itself not performed. |
| A27 | P2 | **Production readiness is not demonstrated.** Live environment reports development; health does not check dependencies. Backup restore, monitoring, production limits, and recovery were not established. **Live + Code** | Pending environment verification, readiness checks, and operational acceptance. Public API docs alone are not treated as a critical vulnerability. |
| A28 | P2 | **CSV cells are formula-capable.** Export a synthetic item named `=1+1`: CSV quoting leaves a formula-like cell for spreadsheet software. No malicious formula was executed. **Browser** | Pending formula neutralization and export consistency/size tests. |
| A29 | P2 | **Tablet horizontal overflow.** At 768px viewport the document grew to 813px, with catalogue controls/table extending the page. **Browser** | Fixed locally: shrinkable grid/cards and wrapping controls; 768px regression passes. |
| A30 | P2 | **Insufficient contrast.** Automated WCAG AA checks identified 28 affected dashboard nodes, three login nodes, and two item-dialog nodes in the tested synthetic states. **Browser/axe** | Pending color correction and manual keyboard/screen-reader assessment. These counts are not a full accessibility inventory. |
| A31 | P2 | **Existing tests mainly assert source strings.** Five runnable structural checks passed despite the behavioral failures above. Full build/test execution was also obstructed by cloud-placeholder files locally. **Code + tests** | Added real database, browser, and API regression tests; full clean-checkout build and broader coverage remain pending. |

## Dependency evidence and interpretation

The scan produced 33 advisory records across two packages, representing 22 distinct advisory IDs—not 33 independently exploitable vulnerabilities. Several findings are conditional or disputed. No exploit/load attack was performed and no authentication bypass is claimed from the scan alone.

- Starlette Range-header CPU exhaustion: affected versions include the freshly resolved 0.47.3; fixed in 0.49.1. The existing FastAPI constraint excludes that fixed Starlette version. [Official advisory](https://github.com/Kludex/starlette/security/advisories/GHSA-7f5h-v6xp-fcq8).
- PyJWT critical-header handling: the pinned 2.10.1 predates the advisory's fix in 2.12.0. Applicability must be checked against the actual token policy. [Official advisory](https://github.com/jpadilla/pyjwt/security/advisories/GHSA-752w-5fwx-jx9f).

## Verification completed for this corrective batch

- **26 PostgreSQL assertions passed:** role/scope access, disabled profile protection, safe profile editing, trusted versus forged audit entries, valid receipts/issues, unit/archive guards, identical retry, changed-payload rejection, NaN rejection, opening-history guard, transfer conservation/replay, concurrent same-key issue, and inactive-center rejection.
- **9 browser checks passed:** scoped editing, stable retry key, latest-center rendering, sign-out behavior, read-only actions, shared token refresh, tablet width, rejected-session recovery, and no uncaught JavaScript errors in those flows.
- **5 isolated Python assertions passed:** nullable clearing, center-filtered PATCH, invalid null rejection, auth outage classification, and HTML gateway handling.
- JavaScript syntax checks passed. All five migrations applied successfully to a fresh disposable PostgreSQL database.

The isolated Python run used package shells and a minimal `InventoryError` substitute because that local file is an unreadable cloud placeholder. The committed unit tests import the real module normally. Therefore this is not a claim that the complete application or deployment suite passed. Some Git/build reads also hung on cloud-placeholder files; current commit status was not independently verified.

## Remaining acceptance checks

1. Restore the intended Supabase dependency, verify matching Render configuration, and test a real approved account in staging.
2. Upgrade vulnerable dependencies and run the full suite from a fully downloaded clean checkout.
3. Apply pending migrations to staging first. Verify existing cost data, then validate the two finite-cost constraints. Do not overwrite financial/stock history to conceal anomalies.
4. Finish the unresolved register entries, including reporting scale/timezones, stock attention, CSV safety, multi-membership, history, and accessibility.
5. Prove multi-center isolation and the agreed inter-center workflow with realistic data. A working within-center transfer is not that proof.
6. Run end-to-end tests against real FastAPI plus a staging Supabase project; test mobile browsers, installed PWA updates, transient failures, rate limits, backups/restoration, and deployment rollback.
7. Rotate credentials previously shared in chat and verify production session/PIN policies before client rollout.

## Evidence files

- `2026-10-11/browser-results.json`: pre-fix synthetic-browser observations.
- `2026-10-11/dependency-scan.json`: dependency scanner output.
- `2026-10-11/tablet-overflow.png`: pre-fix 768px layout evidence.
- `2026-10-11/mobile-dashboard.png`: tested mobile layout evidence.

Application source areas: `public/app.js`, `public/styles.css`, `api/auth.py`, `api/inventory/{router,repository,service,schemas,permissions}.py`, and `supabase/migrations/`. Regression entry points and test prerequisites are documented in the repository README.
