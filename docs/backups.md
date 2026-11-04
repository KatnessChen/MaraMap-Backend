# Backups

MaraMap runs on Supabase **Free** (no automated DB backups — Supabase's own docs
tell free-tier users to dump and store off-site) and Cloudflare R2 (no native
object versioning, no replication). So nothing is backed up unless we do it.
Two scheduled GitHub Actions cover it:

| Workflow | What | When | Destinations |
|---|---|---|---|
| `backup-supabase.yml` | `pg_dump` of `public` schema | nightly 08:00 UTC | GitHub artifact (90d) + R2 `backups/supabase/` |
| `backup-r2.yml` | `rclone sync` of media | weekly Sun 09:00 UTC | Google Drive `MaraMap-R2-Backup/` (off-Cloudflare) |

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

### 2. R2 media backup secrets (Google Drive)

R2 → another R2 bucket is not a backup (same account/credentials die together),
so the media mirror targets Google Drive, using the `sbxew99@gmail.com` account
and a Desktop OAuth client named `MaraMap R2 backup (rclone)` in GCP project
`maramap`.

1. In Google Auth Platform → Audience, keep the status **In production**. In
   Testing, Google expires the refresh token after 7 days, which breaks a weekly
   backup.
2. In Clients, create a **Desktop app** client. Google shows its secret once.
3. Point rclone at it and authorize the backup account:
   ```bash
   rclone config update gdrive client_id=<id> client_secret=<secret> scope=drive.file config_refresh_token=false
   rclone config reconnect gdrive:
   ```
4. Add these repository secrets:

   | Secret | Value |
   |---|---|
   | `GDRIVE_CLIENT_ID` | OAuth client ID |
   | `GDRIVE_CLIENT_SECRET` | OAuth client secret |
   | `GDRIVE_TOKEN` | Output of `rclone config dump \| jq -r .gdrive.token`, piped into `gh secret set` |

The source R2 secrets (`R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`) are the same ones the deploy already uses.

Scope is `drive.file`, so rclone can only see files it created. Do not create the
destination folder by hand; a manually created folder is invisible to rclone.

The first sync copies about 32 GiB. The job limit is 6 hours, and a rerun resumes
where the last one stopped.

Cost: R2 egress is free, and the mirror uses the account's existing Drive quota.

## How the media mirror protects against deletes

`rclone sync` alone would delete from the backup anything deleted at the source —
so a wrongly-deleted post (`fb-posts.service.ts` `remove()` hard-deletes its R2
media) would erase the backup copy too on the next run. The workflow uses
`--backup-dir gdrive:MaraMap-R2-Backup/_deleted/<date>/`, which **moves** vanished objects into
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
rclone copy gdrive:MaraMap-R2-Backup/current r2:<bucket>            # whole bucket back
rclone copyto gdrive:MaraMap-R2-Backup/_deleted/<date>/<key> r2:<bucket>/<key>   # one file
```

## Verification built in

- **DB**: fails the run unless the gz passes an integrity test, is >10 KB,
  contains `CREATE TABLE` for `fb_posts` / `participant_stats` / `page_views`,
  and has ≥100 `fb_posts` data rows. A 0-byte "successful" backup can't happen.
- **Media**: fails unless the Drive mirror is non-empty and its object count is
  within 1% of the source.
