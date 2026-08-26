# Casino X

## Persistent production storage

Casino X uses PostgreSQL when the `DATABASE_URL` environment variable is configured.
For local development, when `DATABASE_URL` is absent, it continues to use `accounts.json`.

### Render deployment

1. Create a Render PostgreSQL database.
2. In the Casino X Web Service, open **Environment**.
3. Add the environment variable `DATABASE_URL` using the PostgreSQL database's **Internal Database URL**.
4. Deploy this version.

On first startup, if PostgreSQL has no accounts, the server imports the existing `accounts.json` accounts and initializes any newer progression fields. Existing session tokens are invalidated during migration so players simply log in again.

If `DATABASE_URL` is configured but PostgreSQL cannot be reached, the server intentionally fails startup instead of silently using ephemeral file storage.

## Included fixes

- Fixed PostgreSQL startup ordering (prevents `ensure_account_progress` NameError).
- Added PostgreSQL persistence with automatic one-time migration from `accounts.json`.
- Fixed paid Store item purchase validation.
- Prevented one account from occupying multiple active table seats.
- Kept local `accounts.json` fallback for development only.
