# MyClient Google Cloud Deployment

This backend deploys manually from GitHub Actions. A normal Git push must not deploy anything.

## One-time Google Cloud setup

Default values:

```text
PROJECT_ID=myclientservices
REGION=europe-west1
GITHUB_REPO=zionbm/MyClient
ARTIFACT_REPOSITORY=myclient
CLOUD_SQL_INSTANCE=myclient-postgres
DATABASE_NAME=myclient
DATABASE_USER=myclient
```

Run:

```bash
PROJECT_ID=myclientservices \
REGION=europe-west1 \
GITHUB_REPO=zionbm/MyClient \
bash scripts/gcp-setup.sh
```

The script prints the GitHub Variables required by the deployment workflow.

The script creates:

- Artifact Registry repository `myclient`.
- Cloud SQL PostgreSQL 16 instance `myclient-postgres`.
- Secret Manager secrets: `OPENAI_API_KEY`, `INTERNAL_API_SECRET`, `DB_PASSWORD`, `DATABASE_URL`, `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`.
- Runtime service account `myclient-runtime`.
- Deployment service account `myclient-github-deployer`.
- Workload Identity Federation restricted to `zionbm/MyClient`.

`INTERNAL_API_SECRET`, `DB_PASSWORD`, and `DATABASE_URL` are populated by the script if needed. The first deployment uses mock LLM and mock STT providers, so `OPENAI_API_KEY` can stay empty. Populate `OPENAI_API_KEY` before switching `ai` or `voice` to real OpenAI providers.

## GitHub configuration

Set these repository variables from the script output:

```text
GCP_PROJECT_ID
GCP_REGION
GCP_ARTIFACT_REGISTRY_REPOSITORY
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_DEPLOY_SERVICE_ACCOUNT
GCP_RUNTIME_SERVICE_ACCOUNT
CLOUD_SQL_INSTANCE_CONNECTION_NAME
```

Do not store application secrets in GitHub. Keep them in Google Secret Manager.

## Manual deployment

Open GitHub Actions, run `Deploy to Google Cloud Run`, and choose:

```text
service=all
deploy=true
run_migrations=true
```

For one service, choose `core`, `ai`, `voice`, `telephony`, or `worker`.

`service=all` deploys in this order:

```text
ai -> voice -> core -> telephony -> worker
```

`core` receives the deployed `ai` and `voice` URLs as runtime configuration. `telephony` and `worker` receive the deployed `core` URL.

The initial workflow deploys `ai` with `MOCK_LLM_PROVIDER=true` and `core`/`voice` with `MOCK_STT_PROVIDER=true`. This keeps the first Cloud Run deployment independent of OpenAI credentials. To enable real AI/STT later, add an `OPENAI_API_KEY` version in Secret Manager and update the workflow env vars and secret bindings.

## Migrations

Prisma migrations are executed explicitly by a Cloud Run Job named:

```text
myclient-prisma-migrate
```

The job uses the `core` image and runs:

```bash
npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
```

Do not run migrations automatically during service startup.

## Rollback

Every image is tagged with the Git SHA:

```text
europe-west1-docker.pkg.dev/myclientservices/myclient/<service>:<git-sha>
```

Rollback by manually redeploying a previous image tag or by rolling Cloud Run traffic back to an earlier revision.

## Public services

Public:

- `myclient-core`
- `myclient-telephony`

Private:

- `myclient-ai`
- `myclient-voice`
- `myclient-worker`

Private service calls use Cloud Run ID tokens when `CLOUD_RUN_SERVICE_AUTH=google`.
