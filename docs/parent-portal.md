# Family portal

The recordings supplied on 21 November 2026 are the product reference. This release implements the first connected parent/staff workflows in the existing FastAPI/Supabase application. The photo gallery follows the dated groups shown in the parent recording and the school-side Albums entry shown in the teacher recording.

## Available now

- `/parents`: responsive parent sign-in and family portal, using the existing school account and Supabase session.
- `/parents?preview=1`: explicit synthetic preview with parent/school-team switching. Preview actions are memory-only and never call the live API; reload resets the examples. Live errors never fall back to preview data.
- Child switching, child/class/academic-year details, a home dashboard, notices, home learning and diary feeds, calendar events and school holidays.
- Shared child conversations between linked guardians and the current assigned school team. Messages are text-only, escaped on rendering, and have a 2,000-character limit. They are not private between one guardian and one teacher; the interface explains who can read them. Users refresh to fetch new messages; there are no push notifications or read receipts.
- School desk: administrators register children in existing classes, edit names/status with optimistic version checks, connect accepted parent accounts and revoke links. Assigned teachers publish class-wide or child-specific updates and calendar events. Authors or administrators may withdraw published updates.
- Photo gallery with dated albums, a full-size viewer, keyboard navigation, captions, and downloads. Staff upload and manage albums from the School desk.
- Feed pagination (20 per page), conversation pagination (30 per page, newest page first), and month-specific calendar queries.
- API responses are `Cache-Control: no-store`; authenticated API traffic remains network-only in the service worker. Logout clears the current portal and dismisses forms. Late responses from a previous child/session cannot replace the current child's content.

## Access model

A center-level parent membership does **not** grant access to every child. An active child link, active parent membership in that child's center, active profile, and active center are required. Administrators link only active, email-confirmed parent accounts in the same center. Invitation acceptance and initial account setup reuse `/school`.

Teachers require both an active teacher membership and a current class assignment in an open academic year. Teacher membership alone does not grant a class roster. Administrators manage children only in their authorized centers. Links, registrations and school posts go through guarded database commands and write audit events; direct table writes are denied to `authenticated` and `anon`. Row-level policies also protect direct table reads. Message authorship is derived from the authenticated identity, never the submitted body.

Student class/center transfers and academic promotion are intentionally not editable through the child form. This avoids exposing old child-specific content or silently moving history between centers. Enrollment history is a later module.

## Local preview

From the repository root, with Python 3.13 and Node.js 22:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
npm ci
```

Use a local `.env` with `SUPABASE_URL=http://127.0.0.1:54321` and blank Supabase keys for a credential-free shell/preview. Start FastAPI:

```sh
python -m uvicorn api.main:app --reload --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/parents?preview=1`. The preview needs no Supabase connection. Normal sign-in requires your configured local or staging Supabase project, all migrations, approved users, and family links.

## Enable on staging

1. Back up the database. Apply all outstanding migrations in filename order, ending with `supabase/migrations/202611210002_parent_gallery.sql`. The gallery migration creates a private bucket in the Supabase Storage schema.
2. Deploy the matching application revision after the migration. `/ready` now calls `parents_gallery_readiness()` and requires schema version `202611210002`; the RPC also checks the existing school/inventory readiness chain. An old database deliberately fails readiness rather than serving an incomplete release.
3. In School administration, prepare an active center, an open academic year, a program, classes, and dated teacher assignments. Invite parent accounts and have them accept with confirmed email addresses.
4. Open the School desk in `/parents` as an administrator. Register a child in a class, then connect the intended parent account. Parent account verification alone does not create the child link.
5. Sign in as the parent and verify child details. Publish a class notice, child-specific diary entry, home activity and calendar event as an assigned teacher. Exchange messages. Verify a second unlinked parent and another center cannot read the child or their data.
6. Create and publish a test album as an assigned teacher. Check that the intended family can view and download it and an unrelated parent cannot. Withdraw a photo and confirm its file is removed from Storage.
7. Verify revocation, account suspension, expired memberships and expired teacher assignments using staging identities. Verify the existing inventory workflows. Complete this acceptance before production release.

No staging or production database was modified during development. SQL integration checks use a disposable loopback PostgreSQL database.

## Verification

```sh
npm test
python -m compileall -q api
python -m unittest discover -s tests -p 'test_*.py'
npx playwright install chromium
# With FastAPI already running on port 8000:
npm run test:parents
npm run test:gallery
```

`TEST_APP_ORIGIN` overrides the browser test origin. `CHROME_PATH` optionally selects an installed Chromium-compatible browser. `TEST_SCREENSHOT_DIR` optionally saves desktop/mobile previews. Browser tests use synthetic data and mocked authentication, including outage handling and delayed responses during child switching.

Run `tests/parents-database-regressions.py` only against an **empty disposable local PostgreSQL database** named `test_*`, supplied through `TEST_DATABASE_URL`. It installs all migrations and verifies real SQL authorization, direct reads/writes, link revocation, profile suspension, membership/assignment expiry, cross-center/class restrictions, private diary targeting, pagination, messages and audit events. It refuses remote and non-test targets. `requirements-dev.txt` includes its database driver.

GitHub Actions runs JS/Python checks, the parent and gallery database suite on PostgreSQL 16, and both browser suites. The gallery SQL test uses a fixture for Storage metadata. Browser tests simulate Storage responses. Run `tests/gallery-database-regressions.py` against a fresh disposable database using the same instructions above. Hosted CI execution remains unverified until this branch is pushed.

## Sharing photos

From **School desk → Share photos**, choose a class, the whole class or one child, and the photo date. Pick up to 12 still JPEG, PNG, or WebP images of up to 10 MiB each and add optional captions. Successful uploads stay in a private draft until publishing completes. Use **Manage albums** to reopen drafts across classes. After a reload, remove any unfinished entries and reselect those files before publishing.

The app corrects image orientation, clears metadata, and stores a resized JPEG plus a thumbnail. Each view checks the current account and album audience. The app serves photos with authenticated requests and does not issue public sharing links. This uses [Supabase private Storage buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals) with album-scoped policies.

Withdrawing an album or removing a photo hides it from families before deleting the stored files. If deletion fails, **Finish photo removals** offers a retry. Copies already saved to a device remain there.

## Next releases from the recordings

Later family features include PDF attachments, child attendance, medical and vaccination records, pickup approval, child preferences, fees, notifications, ratings, and referrals. The teacher recording also shows classwork, planners, staff attendance, and an organizer.

The current calendar supports single-day class events and existing multi-day school holidays. School notices are class-scoped. Rich text, attachments to messages and homework, scheduled publishing, message delivery indicators, enrollment history, and live email delivery verification remain outside this first release.
