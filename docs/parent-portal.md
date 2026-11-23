# Family portal

The recordings supplied on 21 November 2026 are the product reference. This release implements the first connected parent/staff workflows in the existing FastAPI application. The photo gallery follows the dated groups shown in the parent recording and the school-side Albums entry shown in the teacher recording.

## Available now

- `/parents`: responsive parent sign-in and family portal, using the school account and the application session.
- `/parents?preview=1`: explicit synthetic preview with parent/school-team switching. Preview actions are memory-only and never call the live API; reload resets the examples. Live errors never fall back to preview data.
- Child switching, child/class/academic-year details, a home dashboard, notices, home learning and diary feeds, calendar events and school holidays.
- Shared child conversations between linked guardians and the current assigned school team. Messages are text-only, escaped on rendering, and have a 2,000-character limit. They are not private between one guardian and one teacher; the interface explains who can read them. Users refresh to fetch new messages; there are no push notifications or read receipts.
- School desk: administrators register children in existing classes, edit names/status with optimistic version checks, connect accepted parent accounts and revoke links. Assigned teachers publish class-wide or child-specific updates and calendar events. Authors or administrators may withdraw published updates.
- Photo gallery with dated albums, a full-size viewer, keyboard navigation, captions, and downloads. Staff upload and manage albums from the School desk.
- Feed pagination (20 per page), conversation pagination (30 per page, newest page first), and month-specific calendar queries.
- API responses are `Cache-Control: no-store`; authenticated API traffic remains network-only in the service worker. Logout clears the current portal and dismisses forms. Late responses from a previous child/session cannot replace the current child's content.

## Access model

A center-level parent membership does **not** grant access to every child. An active child link, active parent membership in that child's center, active profile, and active center are required. Administrators link only active parent accounts that have finished setup in the same center.

For mobile sign-in, select the working center in School Administration. Go to **People and access → Invite a person**, choose **Parent or guardian**, and use **Mobile number** as the sign-in method. Enter the parent's 10-digit Indian mobile number, create the invitation, and share the one-time link directly with that number. The link expires in seven days. The parent enters the same number to set a six-digit PIN, or signs in with their existing PIN to accept. They can then sign in at `/parents` using that number and PIN. Use **School desk → Connect a family** to link the accepted account to the child. Email invitations remain available from the same form.

Teachers require both an active teacher membership and a current class assignment in an open academic year. Teacher membership alone does not grant a class roster. Administrators manage children only in their authorized centers. The API checks role and child scope before returning records or changing data. Links, registrations and school posts create audit events. Only the backend connects to Turso. Message authorship is derived from the authenticated identity, never the submitted body.

Student class/center transfers and academic promotion are intentionally not editable through the child form. This avoids exposing old child-specific content or silently moving history between centers. Enrollment history is a later module.

## Local preview

From the repository root, with Python 3.13 and Node.js 22:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
npm ci
```

With no Turso URL configured, FastAPI initializes a local SQLite database. Start FastAPI and open `http://127.0.0.1:8000/parents?preview=1` to explore with sample data.

```sh
python -m uvicorn api.main:app --reload --host 127.0.0.1 --port 8000
```

Use the [Turso migration and Render guide](turso-migration.md) for staging, live sign-in, and private photo storage.

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

The Python tests cover the Turso-compatible application datastore and the API, including role boundaries, access revocation, photo upload retries and metadata removal. The PostgreSQL fixtures are kept for backup migration rehearsals.

## Sharing photos

From **School desk → Share photos**, choose a class, the whole class or one child, and the photo date. Pick up to 12 still JPEG, PNG, or WebP images of up to 10 MiB each and add optional captions. Successful uploads stay in a private draft until publishing completes. Use **Manage albums** to reopen drafts across classes. After a reload, remove any unfinished entries and reselect those files before publishing.

The app corrects image orientation, removes embedded metadata, and stores a resized JPEG plus a thumbnail. Each view checks the current account and album audience. Withdrawing an album or removing a photo hides it from families and deletes the stored image bytes in the same transaction. Copies already saved on a device remain there.

## Next releases from the recordings

Later family features include PDF attachments, child attendance, medical and vaccination records, pickup approval, child preferences, fees, notifications, ratings, and referrals. The teacher recording also shows classwork, planners, staff attendance, and an organizer.

The current calendar supports single-day class events and existing multi-day school holidays. School notices are class-scoped. Rich text, attachments to messages and homework, scheduled publishing, message delivery indicators, enrollment history, and live email delivery verification remain outside this first release.
