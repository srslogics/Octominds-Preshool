# Move OctoMinds to Turso

The application uses a libSQL database for records, password sign-in, sessions, and private photo bytes. The API enforces school, class, and child permissions. Turso credentials stay on the server. Photo bytes and album changes commit together. Inventory quantities and costs use integer thousandths and cents, and each stock operation commits with its idempotency record.

## Prepare the data

1. Restore a Supabase PostgreSQL backup into an isolated PostgreSQL instance. The restore must include the app tables in `public` and `auth.users`, including `encrypted_password`. The standard Supabase CLI dump excludes managed schemas by default. [Supabase backup documentation](https://supabase.com/docs/guides/platform/backups)
2. Export the `octominds-parent-photos` bucket separately, preserving `<album-id>/<photo-id>/full.jpg`. The database backup contains file metadata only. [Supabase Storage export options](https://supabase.com/docs/guides/storage/management/download-objects)
3. With the restored database available, create a new local snapshot. Supply the PostgreSQL connection in `OCTOMINDS_BACKUP_DATABASE_URL` through your local environment. Run from the repository root.

```sh
python -m pip install -r requirements-dev.txt
python -m scripts.import_postgres_backup .local/octominds-import.db --objects /path/to/photo-export
```

The command reads a consistent snapshot of the restored source and reports counts per table. It verifies database relationships and refuses to write a snapshot when a published photo is missing or any stock value cannot be represented exactly. It preserves supported password hashes and existing IDs. Accounts without a password use email recovery after the switch. Existing sessions expire at cutover, so users sign in again. The snapshot contains private school data and password hashes. Keep it in a restricted local directory and out of Git.

Create a Turso database from the verified file, using an unused OctoMinds database name. The empty database provisioned for connection testing can stay separate. The file import avoids sending the entire school backup in one long-running application transaction.

```sh
turso db create octominds-import --from-file .local/octominds-import.db --wait
turso db show octominds-import --url
```

Create an app token for that database and store it directly in the Render Environment settings. [Turso CLI quickstart](https://docs.turso.tech/quickstart)

## Configure Render and verify staging

Use the Python Web Service from this branch. Use the existing `pip install -r requirements.txt` build command, `uvicorn api.main:app --host 0.0.0.0 --port $PORT` start command, and `/ready` health check.

| Environment variable | Value |
|---|---|
| `ENVIRONMENT` | `production` |
| `PYTHON_VERSION` | `3.13.5` |
| `TURSO_DATABASE_URL` | The URL returned for the database containing the import |
| `TURSO_AUTH_TOKEN` | An OctoMinds database token |
| `FRONTEND_ORIGIN` | The Render service's HTTPS origin |
| `RESEND_API_KEY` | A sending API key for invitations and account recovery |
| `MAIL_FROM` | A sender address on the verified mail domain |

The deployment uses Resend's HTTPS email API for account confirmation and password recovery. Those flows require a configured sender. Existing password sign-ins use the database directly. Production readiness checks the database schema and an active verified owner. [Resend Email API](https://resend.com/features/email-api)

Verify a representative owner, teacher, and parent sign-in, inventory totals against the source, an idempotent test movement, and a private gallery photo. Test an invitation and a reset email using staging recipients. For the final move, stop writes to the old app before taking the final database and photo backups so the imported records match. Keep the original backup available and point the production service at the final imported database after verification.

## Empty local development database

FastAPI initializes a SQLite file on first start when `TURSO_DATABASE_URL` is empty. Use `python -m scripts.turso_admin owner --email owner@example.test --name "Test Owner"` to create the first local owner. The command prompts for a password. Use `python -m scripts.turso_admin init` to initialize an explicitly configured empty Turso database.

For the import rehearsal, initialize an empty disposable PostgreSQL database called `test_*` and run `python -m tests.rehearse_turso_import` with its local connection in `TEST_DATABASE_URL`. The fixture checks backward-compatible sign-in, stock command retries, and private photo retrieval against the converted snapshot.
