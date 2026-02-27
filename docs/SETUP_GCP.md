# GCP Setup Guide for Cloud Run

Detailed step-by-step guide for one-time GCP configuration. Use this for reference when revisiting how the deployment was set up.

## Prerequisites

- [Google Cloud account](https://cloud.google.com)
- [gcloud CLI](https://cloud.google.com/sdk/docs/install)
- GitHub repository with push access

## Overview

| Step | What |
|------|------|
| 1 | Create or select GCP project |
| 2 | Enable required APIs |
| 3 | Create Artifact Registry repos (dev + prod) |
| 4 | Create service account |
| 5 | Grant IAM roles |
| 6 | Store application secrets in Secret Manager |
| 7 | Set up Workload Identity Federation (WIF) |
| 8 | Add GitHub secrets |

---

## Step 1: Create or Select GCP Project

**Create a new project:**
```bash
gcloud projects create YOUR_PROJECT_ID --name="MaraMap Backend"
```
- Use lowercase, numbers, hyphens only (e.g. `maramap-123456`)

**Or use an existing project:**
```bash
gcloud config set project YOUR_PROJECT_ID
```

**Verify current project:**
```bash
gcloud config get-value project
```

---

## Step 2: Enable Required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com
```

Wait 1–2 minutes for APIs to be enabled.

---

## Step 3: Create Artifact Registry Repositories

One repository per region (same name, different locations).

**Dev (Montreal – northamerica-northeast1):**
```bash
gcloud artifacts repositories create maramap-backend \
  --repository-format=docker \
  --location=northamerica-northeast1 \
  --description="Docker images for MaraMap Backend"
```

**Production (Taiwan – asia-east1):**
```bash
gcloud artifacts repositories create maramap-backend \
  --repository-format=docker \
  --location=asia-east1 \
  --description="Docker images for MaraMap Backend"
```

> If you see "already exists", the repo was created before; you can skip that region.

---

## Step 4: Create Service Account

```bash
gcloud iam service-accounts create github-actions-deploy \
  --display-name="GitHub Actions Cloud Run Deploy"
```

> If you see "already exists", the service account was created before; continue to Step 5.

---

## Step 5: Grant IAM Roles

Set variables (replace `YOUR_PROJECT_ID` if not using `gcloud config`):
```bash
PROJECT_ID=$(gcloud config get-value project)
SA_EMAIL="github-actions-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
```

Grant required roles:
```bash
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/artifactregistry.writer"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"
```

| Role | Purpose |
|------|----------|
| `roles/run.admin` | Deploy to Cloud Run |
| `roles/artifactregistry.writer` | Push Docker images |
| `roles/iam.serviceAccountUser` | Act as the service account for deployments |
| `roles/secretmanager.secretAccessor` | Read secrets from Secret Manager at runtime |

---

## Step 6: Store Application Secrets in Secret Manager

Application credentials are stored in Secret Manager and injected into Cloud Run at startup—no plaintext ever appears in the console or terminal history.

```bash
# Create each secret (you will be prompted to paste the value)
echo -n "YOUR_SUPABASE_URL" | \
  gcloud secrets create supabase_url \
    --data-file=- \
    --replication-policy=automatic

echo -n "YOUR_SUPABASE_SERVICE_ROLE_KEY" | \
  gcloud secrets create supabase_service_role_key \
    --data-file=- \
    --replication-policy=automatic
```

Grant the service account read access to each secret:
```bash
for SECRET in supabase_url supabase_service_role_key; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor"
done
```

> Cloud Run will mount these as environment variables via `--set-secrets` in the deploy command. The values are never stored in workflow files or the UI.

---

## Step 7: Set up Workload Identity Federation (WIF)

WIF allows GitHub Actions to authenticate with GCP using short-lived OIDC tokens (max 1 hour) instead of a permanent JSON key.

### 7.1 Create a WIF Pool

```bash
gcloud iam workload-identity-pools create "github-actions-pool" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --display-name="GitHub Actions Pool"
```

### 7.2 Create an OIDC Provider

```bash
gcloud iam workload-identity-pools providers create-oidc "github-actions-provider" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="github-actions-pool" \
  --display-name="GitHub Actions Provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository"
```

### 7.3 Bind the Service Account to the Pool

```bash
POOL_ID=$(gcloud iam workload-identity-pools describe "github-actions-pool" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --format="value(name)")

gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/KatnessChen/MaraMap-Backend"
```

### 7.4 Get the Provider Resource Name (for GitHub secret)

```bash
gcloud iam workload-identity-pools providers describe "github-actions-provider" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="github-actions-pool" \
  --format="value(name)"
```

Copy the output—it looks like:
`projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions-provider`

---

## Step 8: Add GitHub Secrets

1. Go to the repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Add:

| Secret Name | Value |
|-------------|-------|
| `GCP_PROJECT_ID` | Your project ID (e.g. `maramap-123456`) |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Provider resource name from Step 7.4 |

---

## Deployments

| Branch   | Environment | Region                    |
|----------|-------------|---------------------------|
| `main`   | production  | asia-east1 (Taiwan)       |
| `develop`| dev         | northamerica-northeast1 (Montreal) |

```bash
# Production
git push origin main

# Dev
git checkout develop  # or: git checkout -b develop
git push origin develop
```

---

## Verification

1. **GitHub Actions** – Actions tab for workflow status
2. **Cloud Run** – [console.cloud.google.com/run](https://console.cloud.google.com/run)
3. **Health check** – `curl https://YOUR_SERVICE_URL/health-check`

---

## Managing Secrets

To update an existing secret value:

```bash
echo -n "NEW_VALUE" | gcloud secrets versions add SECRET_NAME --data-file=-
```

To list all secrets:

```bash
gcloud secrets list
```

> Cloud Run automatically uses the `latest` version. No redeployment needed for secret value changes—restart the service revision to pick up new values.
