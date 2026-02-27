# GitHub Actions CI/CD Setup

## Overview

This project uses GitHub Actions to automate testing and deployment. Two workflows work together:

1. **Test** (`.github/workflows/test.yml`) — Triggered on every `push` to `develop` and `main` branches
2. **Deploy** (`.github/workflows/deploy-cloud-run.yml`) — Automatically triggered after `Test` workflow succeeds

---

## Workflow: Test

### Trigger

- On any `push` to `develop` or `main` branches
- On any `pull_request` targeting `develop` or `main` branches

### Steps

```
1. Checkout code
2. Setup Node.js 20.x
3. Install pnpm
4. Install dependencies (with cache)
5. Run linter (pnpm lint)
6. Run unit + integration tests (pnpm test)
7. Run e2e tests (pnpm test:e2e)
8. Check coverage (pnpm test:cov)
9. Upload coverage to Codecov (optional, non-blocking)
```

### Result

- ✅ **Success**: All tests pass, coverage meets threshold
- ❌ **Failure**: Blocks deployment (see Deploy workflow)

---

## Workflow: Deploy

### Trigger

- Automatically after `Test` workflow completes successfully on `develop` or `main` branches
- Only runs if `Test` workflow conclusion is `success`

### Environment Routing

| Branch | Region | Service | Config |
|--------|--------|---------|--------|
| `develop` | `northamerica-northeast1` (Montreal) | `maramap-backend-dev` | Dev environment |
| `main` | `asia-east1` (Taiwan) | `maramap-backend-prod` | Production environment |

### Steps

```
1. Authenticate to GCP (Workload Identity)
2. Setup gcloud CLI
3. Configure Docker for Artifact Registry
4. Build Docker image (tag: git SHA)
5. Push image to Artifact Registry
6. Deploy to Cloud Run with environment secrets
```

### Environment Variables Injected

At deploy time, these secrets are injected from GitHub Secrets (different for dev and prod):

- `SUPABASE_URL` → `SUPABASE_URL_DEV` or `SUPABASE_URL_PROD`
- `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_KEY_DEV` or `SUPABASE_KEY_PROD`
- `N8N_WEBHOOK_URL` (configured per environment)
- `INTERNAL_API_SECRET` (configured per environment)

---

## GitHub Secrets Required

Set these in your GitHub repository settings (`Settings > Secrets and variables > Actions`):

### GCP Deployment

| Secret | Description | Example |
|--------|-------------|---------|
| `GCP_PROJECT_ID` | Your GCP project ID | `my-maramap-project` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Provider resource name | `projects/123456/locations/global/workloadIdentityPools/github-pool/providers/github` |

### Supabase (Dev)

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL_DEV` | Supabase project URL (dev) |
| `SUPABASE_KEY_DEV` | Supabase service-role key (dev) |

### Supabase (Production)

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL_PROD` | Supabase project URL (production) |
| `SUPABASE_KEY_PROD` | Supabase service-role key (production) |

### n8n Webhooks

| Secret | Description |
|--------|-------------|
| `N8N_WEBHOOK_URL_DEV` | n8n webhook trigger URL (dev) |
| `N8N_WEBHOOK_URL_PROD` | n8n webhook trigger URL (production) |

### API Security

| Secret | Description |
|--------|-------------|
| `INTERNAL_API_SECRET_DEV` | Secret for n8n callbacks (dev) |
| `INTERNAL_API_SECRET_PROD` | Secret for n8n callbacks (production) |

---

## Branch Protection Rules

To enforce that tests must pass before merging, configure branch protection rules:

1. Go to `Settings > Branches > Add Rule`
2. Apply to branches: `develop`, `main`
3. Require status checks to pass:
   - ✅ `test` workflow
4. Require branches to be up to date before merging
5. Require code review before merging (recommended)

---

## Monitoring & Debugging

### Check Test Results

1. Go to `Actions` tab
2. Click on `Test` workflow
3. Click the specific run to see logs

### Check Deployment Status

1. Go to `Actions` tab
2. Click on `Deploy to Cloud Run` workflow
3. Click the specific run — if it didn't appear, tests failed

### Common Issues

| Issue | Solution |
|-------|----------|
| Tests fail locally but pass in CI | Run `pnpm install` and `pnpm test` to reproduce |
| Deploy doesn't trigger after test pass | Check that the test run's conclusion was `success` |
| Secrets not found in deploy | Verify secret names in GitHub exactly match the env variable names in the workflow |
| Docker image fails to push | Check `GCP_PROJECT_ID` and Artifact Registry region setting |

---

## Manual Deployment (if needed)

If you need to deploy without running through the workflow:

1. **Dev environment** — manually trigger `Deploy to Cloud Run` from GitHub Actions
2. **Production** — only deploy from the `main` branch workflow (automatic after tests pass)

---

## Cost Optimization

- Test workflow runs on every push — set up code review (require PR approval) to avoid excessive runs
- Use `actions/cache@v3` to cache `pnpm store` and speed up installs
- Cloud Run uses `min-instances=1` per environment for 24/7 availability (configured in GCP)
