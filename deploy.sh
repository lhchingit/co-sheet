#!/usr/bin/env bash
#
# Deploy co-sheet to Google Cloud Run (build from source) backed by Cloud SQL
# for PostgreSQL. This script covers the *repeatable* build + deploy step. The
# one-time infrastructure setup (enabling APIs, creating the Cloud SQL instance,
# database and user, and the Google OAuth client) is documented in DEPLOY.md.
#
# Usage:
#   DB_PASS=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... ./deploy.sh
#
# Re-run after the first deploy with BASE_URL set to the service URL so OAuth
# callbacks resolve correctly.
#
set -euo pipefail

# --- Configuration (override any of these via the environment) ----------------
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-cosheet}"
SQL_INSTANCE="${SQL_INSTANCE:-cosheet-db}"   # Cloud SQL instance (short name)
DB_NAME="${DB_NAME:-cosheet}"
DB_USER="${DB_USER:-postgres}"
CONTAINER_PORT="${CONTAINER_PORT:-3000}"     # matches Dockerfile EXPOSE

# --- Required secrets ---------------------------------------------------------
: "${DB_PASS:?Set DB_PASS to the Cloud SQL password for ${DB_USER}}"
: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID (Google OAuth client id)}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET (Google OAuth client secret)}"
SUPER_ADMIN_EMAILS="${SUPER_ADMIN_EMAILS:-}"
BASE_URL="${BASE_URL:-}"                      # set after first deploy

if [ -z "${PROJECT_ID}" ]; then
  echo "ERROR: PROJECT_ID is empty and no gcloud default project is set." >&2
  echo "       Run: gcloud config set project <your-project-id>" >&2
  exit 1
fi

CONN_NAME="${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
# Cloud SQL connects over a Unix socket inside the container, so no SSL config is
# needed in the app (unlike a public TCP connection to Neon/Vercel Postgres).
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@/${DB_NAME}?host=/cloudsql/${CONN_NAME}"

# Build the env file out of band so values containing commas (SUPER_ADMIN_EMAILS)
# or URL punctuation (DATABASE_URL) are passed verbatim, which --set-env-vars
# comma-splitting would otherwise mangle.
ENV_FILE="$(mktemp)"
trap 'rm -f "${ENV_FILE}"' EXIT
{
  echo "NODE_ENV: \"production\""
  echo "DATABASE_URL: \"${DATABASE_URL}\""
  echo "GOOGLE_CLIENT_ID: \"${GOOGLE_CLIENT_ID}\""
  echo "GOOGLE_CLIENT_SECRET: \"${GOOGLE_CLIENT_SECRET}\""
  echo "SUPER_ADMIN_EMAILS: \"${SUPER_ADMIN_EMAILS}\""
  [ -n "${BASE_URL}" ] && echo "BASE_URL: \"${BASE_URL}\""
} > "${ENV_FILE}"

echo "Deploying '${SERVICE}' to ${PROJECT_ID}/${REGION}"
echo "  Cloud SQL instance : ${CONN_NAME}"
echo "  Instances          : pinned to 1 (in-process WebSocket + session state)"
[ -z "${BASE_URL}" ] && echo "  NOTE: BASE_URL unset — set it on the next run for OAuth callbacks."

# --min/--max-instances=1: live edits broadcast only to sockets on the same
# process and sessions live in memory, so the app must run as a single instance
# until a shared pub/sub + session store are added. See DEPLOY.md > Scaling.
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --source=. \
  --region="${REGION}" \
  --platform=managed \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=1 \
  --timeout=3600 \
  --port="${CONTAINER_PORT}" \
  --add-cloudsql-instances="${CONN_NAME}" \
  --env-vars-file="${ENV_FILE}"

URL="$(gcloud run services describe "${SERVICE}" --project="${PROJECT_ID}" \
  --region="${REGION}" --format='value(status.url)')"

echo
echo "Deployed: ${URL}"
if [ -z "${BASE_URL}" ]; then
  echo "Next steps:"
  echo "  1. Add ${URL}/api/auth/callback/google to the Google OAuth client's"
  echo "     'Authorized redirect URIs'."
  echo "  2. Re-run with BASE_URL=${URL} so server-side OAuth redirects match."
fi
