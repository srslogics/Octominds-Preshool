# OctoMinds Phase 1 - Platform Foundation

This workspace contains the first working product foundation for OctoMinds.

## Included

- Responsive mobile-number and PIN sign-in interface using an internal no-SMS Supabase password identity
- Role-aware navigation and branch context
- Operations dashboard with reusable cards, tables, forms, dialogs, toasts, and profile drawer
- Desktop and mobile navigation
- PWA manifest and service worker shell
- FastAPI foundation with health, session, and role-protected endpoints
- Supabase JWT configuration seam
- Request logging, CORS controls, environment configuration, and Render blueprint

## Preview

Serve the `public` directory with any static web server. The application does not include demo credentials or simulated authentication. Sign-in remains unavailable until the approved Supabase and API environments are configured.

## Render deployment

`render.yaml` provisions one Python web service. FastAPI serves the protected API, runtime browser configuration, frontend, and PWA from the same Render domain. Set the requested Supabase environment values in Render when deploying the Blueprint; never commit database or JWT secrets.

## API setup

1. Run `supabase/migrations/202608160001_phase_1_foundation.sql` in the approved Supabase project.
2. Create each approved user with the internal identity `<10-digit-mobile>@auth.octominds.invalid`, a strong six-digit PIN as the password, and their real phone number in the profile. This keeps the user-facing mobile-number login without enabling SMS/OTP.
3. Create the owner identity and run `supabase/bootstrap_owner.sql` with the owner's E.164 number.
4. Copy `.env.example` to `.env` and provide the Supabase values.
5. Set `public/config.js` to the approved Supabase URL, anonymous key, and API URL.
6. Install `requirements.txt` in a Python virtual environment.
7. Start `uvicorn api.main:app --reload`.

Authentication and application access are denied by default until the user has an active profile and membership. The API verifies every Supabase token and reloads role and branch access from the database on each session request.
