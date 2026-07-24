# Backups

MaraMap runs on Supabase **Free** (no automated DB backups — Supabase's own docs
tell free-tier users to dump and store off-site) and Cloudflare R2 (no native
object versioning, no replication). So nothing is backed up unless we do it.
Two scheduled GitHub Actions cover it:

| Workflow | What | When | Destinations |
|---|---|---|---|
| `backup-supabase.yml` | `pg_dump` of `public` schema | nightly 08:00 UTC | GitHub artifact (90d) + R2 `backups/supabase/` |
| `backup-r2.yml` | `rclone sync` of media | weekly Sun 09:00 UTC | Backblaze B2 (off-Cloudflare) |

Both open a GitHub issue labelled `backup-failure` if they fail, and both have a
`workflow_dispatch` button to run on demand from the Actions tab.

## One-time setup

### 1. Supabase backup secret

`Settings → Secrets and variables → Actions → New repository secret`:

- **`SUPABASE_DB_URL`** — the **Session pooler** connection string.
  Supabase Dashboard → Project Settings → Database → Connection string →
  **Session pooler** tab. Shape:
  ```
  postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
  ```
  ⚠️ Must be the **Session pooler** (port 5432 on `*.pooler.supabase.com`).
  - The **direct** host `db.<ref>.supabase.co` is IPv6-only → GitHub runners are
    IPv4-only → "Network is unreachable".
  - The **Transaction pooler** on `:6543` does not support `pg_dump`.

Once this secret exists the nightly DB backup works. The R2 copy step is skipped
automatically until the R2 secrets below are present — the GitHub artifact alone
is already a real backup.

### 2. R2 media backup secrets (Backblaze B2)

R2 → another R2 bucket is not a backup (same account/credentials die together),
so the media mirror targets Backblaze B2.

1. Create a B2 account and a **private** bucket, e.g. `maramap-media-backup`.
2. Create an application key scoped to that bucket → note the keyID and appKey.
3. Note the bucket's S3 endpoint (B2 bucket page), e.g.
   `https://s3.us-west-004.backblazeb2.com`.
4. Add these repository secrets:

   | Secret | Value |
   |---|---|
   | `B2_ENDPOINT` | `https://s3.us-west-004.backblazeb2.com` |
   | `B2_BUCKET_NAME` | `maramap-media-backup` |
   | `B2_KEY_ID` | B2 application keyID |
   | `B2_APP_KEY` | B2 application key |

The source R2 secrets (`R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`) are the same ones the deploy already uses.

Cost: R2 egress is free; B2 storage ≈ $6/TB/mo → ~$0.07/mo for the current 11 GB.

## How the media mirror protects against deletes

`rclone sync` alone would delete from the backup anything deleted at the source —
so a wrongly-deleted post (`fb-posts.service.ts` `remove()` hard-deletes its R2
media) would erase the backup copy too on the next run. The workflow uses
`--backup-dir b2:<bucket>/_deleted/<date>/`, which **moves** vanished objects into
a dated tombstone folder instead of deleting them. Live mirror is under
`current/`; recoverable deletions accumulate under `_deleted/`.

Prune `_deleted/` occasionally if it grows — it is pure safety margin, not needed
for a normal restore.

## Restore

### Database
```bash
gzip -dc maramap-YYYY-MM-DD.sql.gz | psql "<SUPABASE_DB_URL session pooler>"
```
The dump is `--clean --if-exists`, so it drops and recreates the `public` objects.
**Not included:** the `auth` schema — `auth.users`, i.e. the admin login, is not
dumped (the project role can't fully export the managed schemas). After a restore
into a fresh project, recreate the admin user via Supabase Auth.

### Media
```bash
rclone copy b2:<bucket>/current r2:<bucket>            # whole bucket back
rclone copy b2:<bucket>/_deleted/<date>/<key> r2:<bucket>/<key>   # one file
```

## Verification built in

- **DB**: fails the run unless the gz passes an integrity test, is >10 KB,
  contains `CREATE TABLE` for `fb_posts` / `participant_stats` / `page_views`,
  and has ≥100 `fb_posts` data rows. A 0-byte "successful" backup can't happen.
- **Media**: fails unless the B2 mirror is non-empty and its object count is
  within 1% of the source.
