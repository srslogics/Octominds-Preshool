# Modules 1 and 2: school setup and user access

Implementation status: local code and automated checks completed. This release has not been applied to the live Supabase project or deployed to Render. Browser checks use synthetic records; database checks run against disposable local PostgreSQL databases. A local Supabase runtime has also verified actual owner/admin/teacher sign-in, scoped reads, persisted saves, stale-edit rejection, teacher write denial and recovery email capture. External email delivery and the complete hosted authentication flow still require staging acceptance.

## Module 1 — School and center setup

Entry point: `/school.html`. Inventory links to School administration; school administration links back to inventory for eligible roles. Both use the existing signed-in session.

| Screen | Implemented behavior |
| --- | --- |
| Overview | Center count and selected-center counts for years, programs and classes; setup sequence. |
| School profile | One school identity with name, email, telephone, address and website. Owner/management maintain it. |
| Centers | Name, unique code, contact details, timezone, working-day checkboxes, local opening/closing hours, optional capacity and active/archive status. Center administrators edit their own center details; management creates or archives centers. |
| Academic years | Named date ranges and planned/active/closed status per center. Only one active year per center. Closed years cannot be reopened or rewritten through the application. |
| Terms | Named date ranges contained within an open academic year, with the same center enforced. |
| Programs | Center-specific program names and descriptions, with archive status. |
| Classes and sections | Year, program, class name, section, room, capacity and active/archive status. Related records must belong to the same center. |
| Teacher assignments | Assign an active teacher at that center to an active class in an open year. Start/end dates support temporary cover. Changing teacher/class requires a new assignment, retaining the earlier record. |
| Holidays | Named center closures with start/end dates and active/archive status. |
| Administration history | The latest 100 school administration events, filtered by the administrator's authorized centers. Detailed before/after setup changes are retained in the database audit log. |

All edits include the record version: if two administrators edit the same record, the stale save is rejected with a reload message. Normal screens archive records where supported instead of deleting history. Year date changes cannot cut off existing terms or teacher assignments. Closed-year terms, classes and assignments are read only.

Recommended setup sequence: school profile → center → academic year → programs → terms/classes → staff invitation and acceptance → teacher assignments → holidays. Prepare a new year as planned, create its classes, then close the old year and activate the new one.

Capacity is stored configuration, not enrollment-based occupancy enforcement. Student admission, class enrollment and promotion must connect to it when the student module is implemented.

## Module 2 — Accounts and access

One account can have multiple roles and center memberships. Existing mobile/PIN accounts remain supported. Newly invited accounts use a verified email and password.

| Role | Setup access | Account administration | Existing inventory |
| --- | --- | --- | --- |
| Owner (`super_admin`) | All centers and school identity | Invite/assign roles; revoke another person's memberships; suspend/reactivate another account | Read/write |
| Management | All centers and school identity | Assign center roles; cannot grant owner/management or globally suspend accounts | Read/write |
| Center administrator | Manage own active center's setup; cannot create/archive centers | Invite/assign teacher, admissions, accountant and parent roles in own center | Read/write in own center |
| Accountant | Read authorized center setup | Own account only | Read only in own center |
| Teacher | Read authorized center setup; own teacher assignments | Own account only | No access |
| Admissions counsellor | Read authorized center setup | Own account only | No access |
| Parent/guardian | Read authorized center setup; no staff assignments | Own account only | No access |

These are predefined roles. This release does not introduce an arbitrary permission builder or a parent portal containing child records.

### Invitation and activation

1. An administrator chooses the recipient's email, name, role, center and optional access expiry.
2. The application displays a random invitation link once. The administrator copies and shares it; this release does not automatically send the invitation message.
3. The recipient signs in or creates an account with the invited email. Email confirmation must be enabled in Supabase.
4. The database checks the verified email, invitation validity, active center/account and the inviting administrator's current authority before adding access.
5. The invitation is single use and expires in seven days. Its token is stored only as a SHA-256 hash. It is not included in the directory or audit metadata.

Invitation expiry and membership expiry are separate. Invitations stop working after revocation, use or expiry. Membership expiry ends school and inventory access at the configured timestamp. To renew an expired membership, revoke the old membership and assign a new one. Owners cannot be assigned automatic expiry. Another owner must change an owner's own access.

Existing accounts can receive additional roles. Center administrators can directly assign only accounts already belonging to their center; other people must accept an invitation. An unassigned account gains no school access by signing up alone. Invalid invitations can be dismissed so they do not prevent a person signing into an existing account.

### Recovery, suspension and sessions

- Email accounts can request password recovery and change their password after the recovery link. The UI requires at least 12 characters for new email passwords.
- Existing mobile accounts can change their six-digit PIN while signed in. Forgotten PINs still require the established administrator process; an SMS recovery service is not included.
- Sign out clears displayed school data and local credentials, informs other open tabs, and requests Supabase session revocation. A delayed response cannot repopulate the signed-out workspace.
- Users can request sign out on all devices. Supabase access tokens already issued may remain valid until their expiry; global logout is not represented as instant token invalidation.
- Account suspension and membership revocation are separately checked at the database boundary, so an existing identity cannot continue reading or writing school/inventory data after access is removed.
- Shared account, roles, center membership and access rules are reused by inventory. Teacher/parent access never grants inventory access.

## Architecture

The release extends the existing plain HTML/CSS/JavaScript frontend, FastAPI service and Supabase PostgreSQL architecture.

- `public/school.html`, `school.css` and `school.js`: responsive school workspace, authentication and account forms.
- `api/school/router.py`: typed request validation and versioned `/api/v1/school` endpoints.
- `202610260001_school_foundation.sql`: additive migration, setup tables, membership expiry, scoped reads, guarded write commands and audit events.
- School reads use row-level security. API calls pass the caller's bearer token and public Supabase key; they do not use a service-role key to bypass permissions.
- Database commands enforce role/center scope, relationship integrity, invitation ownership and edit versions even if someone calls the database API directly.
- The existing inventory center-creation command delegates to the shared school center command and keeps its return shape.
- `/ready` now requires school schema version `202610260001`, along with inventory readiness and authentication availability.
- The service worker includes the school shell. Authenticated API responses are not cached; edits require a network connection. There is no offline write queue. The existing installed-app entry point remains inventory.

## Deployment order and staging acceptance

1. Back up the configured Supabase database and confirm that the existing owner has active access.
2. Apply pending migrations in filename order to staging. The required sequence now includes `202610130001_inventory_reporting.sql` and `202610260001_school_foundation.sql`. Do not rerun already-applied migrations.
3. Configure Supabase email/password authentication, **Confirm email**, production SMTP and the actual HTTPS `/school.html` URL in the redirect allowlist. Set the corresponding site URL. Do not disable email confirmation: invitation acceptance depends on a verified identity.
4. Configure a server-side password policy and authentication rate limits appropriate for launch. Existing six-digit PIN accounts need a deliberate migration policy before increasing a project-wide minimum that would break their sign-in/recovery.
5. Deploy the application only after the migration is in place. The new API expects `user_memberships.expires_at`; deploying code first can break authentication. `/ready` must return healthy with version `202610260001`.
6. Complete staging checks with real email accounts: invitation signup/confirmation, invitation to an existing account, recovery links in the same and a new tab, wrong recipient, expired/revoked invitation, temporary access, suspension, another center's access, and inventory stock operations.
7. Verify the configured Supabase deployment can deliver confirmation/recovery messages, the redirect URLs are correct and no private keys appear in `/config.js`.
8. Apply the same migration and release to production after staging acceptance. Keep the database additive on application rollback; do not drop setup/history tables to roll back the UI.

Existing owner bootstrap remains an authorized database/operator task. The browser cannot make itself the first owner. No production database was modified while building this release.

## Verification

- `npm test`: static build, JavaScript syntax and 9 existing checks.
- `python -m unittest discover -s tests -p 'test_*.py'`: 20 API/service tests, including school validation, version handling, bearer propagation, invitation acceptance before membership and expired roles.
- `tests/school-database-regressions.py`: 60 checks against all migrations in an empty local PostgreSQL database named `test_*`.
- `tests/inventory-security-regression.py`: 34 inventory checks with the new school migration also applied, including stock integrity and concurrency.
- `tests/school-browser-regressions.cjs`: 15 browser checks, including desktop/mobile behavior, invitation/recovery flows, stale edits, role controls, logout races and automated WCAG A/AA checks on the access screen.
- `tests/inventory-pages.cjs`: inventory routes, history, refresh, filters, viewport checks and automated accessibility.

Database tests require `psycopg2-binary` and `TEST_DATABASE_URL`; they reject remote or non-test databases. Browser tests require Playwright, axe-core, a server serving `public/`, `TEST_APP_ORIGIN` and optionally `CHROME_PATH`. `TEST_SCREENSHOT_DIR` saves school screenshots when supplied. Browser results do not establish live Supabase email delivery or a hosted end-to-end pass.

## Further product work

The following are outside this implementation: child/guardian linking, admissions, student promotion, timetable conflict detection, occupancy against student enrollments, attendance, fees, payroll, transport, procurement additions, custom role definitions, MFA/SSO, SMS/WhatsApp delivery, offline writes and a multi-school SaaS tenant model. Inventory remains the existing implemented module. Add these as explicit subsequent modules rather than presenting their placeholder roles or configuration fields as finished functionality.
