#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-myclientservices}"
REGION="${REGION:-europe-west1}"
GITHUB_REPO="${GITHUB_REPO:-zionbm/MyClient}"

ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-myclient}"
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-myclient-runtime}"
DEPLOY_SA_NAME="${DEPLOY_SA_NAME:-myclient-github-deployer}"
WORKLOAD_IDENTITY_POOL="${WORKLOAD_IDENTITY_POOL:-myclient-github-pool}"
WORKLOAD_IDENTITY_PROVIDER="${WORKLOAD_IDENTITY_PROVIDER:-myclient-github-provider}"
CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-myclient-postgres}"
DATABASE_NAME="${DATABASE_NAME:-myclient}"
DATABASE_USER="${DATABASE_USER:-myclient}"

RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com \
  compute.googleapis.com \
  serviceusage.googleapis.com \
  orgpolicy.googleapis.com \
  firebase.googleapis.com \
  identitytoolkit.googleapis.com \
  securetoken.googleapis.com \
  --project="${PROJECT_ID}"

gcloud artifacts repositories describe "${ARTIFACT_REPOSITORY}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1 || \
gcloud artifacts repositories create "${ARTIFACT_REPOSITORY}" \
  --repository-format=docker \
  --location="${REGION}" \
  --description="MyClient service Docker images" \
  --project="${PROJECT_ID}"

for secret in OPENAI_API_KEY INTERNAL_API_SECRET DB_PASSWORD DATABASE_URL PLIVO_AUTH_ID PLIVO_AUTH_TOKEN; do
  gcloud secrets describe "${secret}" --project="${PROJECT_ID}" >/dev/null 2>&1 || \
    gcloud secrets create "${secret}" --replication-policy=automatic --project="${PROJECT_ID}"
done

if ! gcloud secrets versions list INTERNAL_API_SECRET --project="${PROJECT_ID}" --format="value(name)" | grep -q .; then
  openssl rand -base64 32 | gcloud secrets versions add INTERNAL_API_SECRET --data-file=- --project="${PROJECT_ID}" >/dev/null
fi
if ! gcloud secrets versions list DB_PASSWORD --project="${PROJECT_ID}" --format="value(name)" | grep -q .; then
  openssl rand -base64 32 | tr -d '=+/' | cut -c1-32 | gcloud secrets versions add DB_PASSWORD --data-file=- --project="${PROJECT_ID}" >/dev/null
fi

gcloud iam service-accounts describe "${RUNTIME_SA}" --project="${PROJECT_ID}" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "${RUNTIME_SA_NAME}" --display-name="MyClient Cloud Run runtime" --project="${PROJECT_ID}"
gcloud iam service-accounts describe "${DEPLOY_SA}" --project="${PROJECT_ID}" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "${DEPLOY_SA_NAME}" --display-name="MyClient GitHub deployer" --project="${PROJECT_ID}"

for role in roles/cloudsql.client roles/secretmanager.secretAccessor roles/firebasecloudmessaging.admin; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="${role}" \
    --quiet >/dev/null
done

for role in roles/run.admin roles/artifactregistry.writer roles/cloudsql.client; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="${role}" \
    --quiet >/dev/null
done

gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --project="${PROJECT_ID}" \
  --quiet >/dev/null

if ! gcloud sql instances describe "${CLOUD_SQL_INSTANCE}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud sql instances create "${CLOUD_SQL_INSTANCE}" \
    --project="${PROJECT_ID}" \
    --database-version=POSTGRES_16 \
    --edition=enterprise \
    --region="${REGION}" \
    --tier=db-f1-micro \
    --storage-type=SSD \
    --storage-size=10 \
    --availability-type=zonal \
    --no-backup
fi

gcloud sql databases describe "${DATABASE_NAME}" --instance="${CLOUD_SQL_INSTANCE}" --project="${PROJECT_ID}" >/dev/null 2>&1 || \
  gcloud sql databases create "${DATABASE_NAME}" --instance="${CLOUD_SQL_INSTANCE}" --project="${PROJECT_ID}"

DB_PASSWORD="$(gcloud secrets versions access latest --secret=DB_PASSWORD --project="${PROJECT_ID}")"
if gcloud sql users list --instance="${CLOUD_SQL_INSTANCE}" --project="${PROJECT_ID}" --format="value(name)" | grep -qx "${DATABASE_USER}"; then
  gcloud sql users set-password "${DATABASE_USER}" --instance="${CLOUD_SQL_INSTANCE}" --password="${DB_PASSWORD}" --project="${PROJECT_ID}"
else
  gcloud sql users create "${DATABASE_USER}" --instance="${CLOUD_SQL_INSTANCE}" --password="${DB_PASSWORD}" --project="${PROJECT_ID}"
fi

CLOUD_SQL_CONNECTION_NAME="$(gcloud sql instances describe "${CLOUD_SQL_INSTANCE}" --project="${PROJECT_ID}" --format="value(connectionName)")"
DATABASE_URL_VALUE="postgresql://${DATABASE_USER}:${DB_PASSWORD}@localhost/${DATABASE_NAME}?host=/cloudsql/${CLOUD_SQL_CONNECTION_NAME}&schema=public"
printf "%s" "${DATABASE_URL_VALUE}" | gcloud secrets versions add DATABASE_URL --data-file=- --project="${PROJECT_ID}" >/dev/null

gcloud iam workload-identity-pools describe "${WORKLOAD_IDENTITY_POOL}" --location=global --project="${PROJECT_ID}" >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create "${WORKLOAD_IDENTITY_POOL}" \
    --location=global \
    --display-name="MyClient GitHub pool" \
    --project="${PROJECT_ID}"

gcloud iam workload-identity-pools providers describe "${WORKLOAD_IDENTITY_PROVIDER}" \
  --workload-identity-pool="${WORKLOAD_IDENTITY_POOL}" \
  --location=global \
  --project="${PROJECT_ID}" >/dev/null 2>&1 || \
gcloud iam workload-identity-pools providers create-oidc "${WORKLOAD_IDENTITY_PROVIDER}" \
  --workload-identity-pool="${WORKLOAD_IDENTITY_POOL}" \
  --location=global \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == '${GITHUB_REPO}'" \
  --display-name="MyClient GitHub provider" \
  --project="${PROJECT_ID}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")"
PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WORKLOAD_IDENTITY_POOL}/attribute.repository/${GITHUB_REPO}"
gcloud iam service-accounts add-iam-policy-binding "${DEPLOY_SA}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${PRINCIPAL}" \
  --quiet >/dev/null

cat <<EOF
GCP_PROJECT_ID=${PROJECT_ID}
GCP_REGION=${REGION}
GCP_ARTIFACT_REGISTRY_REPOSITORY=${ARTIFACT_REPOSITORY}
GCP_WORKLOAD_IDENTITY_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WORKLOAD_IDENTITY_POOL}/providers/${WORKLOAD_IDENTITY_PROVIDER}
GCP_DEPLOY_SERVICE_ACCOUNT=${DEPLOY_SA}
GCP_RUNTIME_SERVICE_ACCOUNT=${RUNTIME_SA}
CLOUD_SQL_INSTANCE_CONNECTION_NAME=${CLOUD_SQL_CONNECTION_NAME}
EOF
