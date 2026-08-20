#!/usr/bin/env bash
set -euo pipefail

GCP_PROJECT="big-command-495016-i9"
VERCEL_SCOPE="rjatomicfuzz-7072s-projects"
VERCEL_PROJECT="afy-free-rank-gateway"
KEY_DISPLAY="AFY Free Rank Gateway - Places IDs Only"
WORKDIR="$HOME/afy-free-rank-gateway-deploy"
REPO_URL="https://github.com/rjatomicfuzz-sys/afy-skills.git"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud is not installed. Run this script in Google Cloud Shell."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is not installed."
  exit 1
fi

echo "== AFY FREE RANK GATEWAY DEPLOY =="
echo "Google project: $GCP_PROJECT"
echo "Vercel project: $VERCEL_PROJECT"

gcloud config set project "$GCP_PROJECT" >/dev/null

echo
echo "Active Google account:"
gcloud auth list --filter=status:ACTIVE --format="value(account)"

echo
echo "Enabling Places API + API Keys API..."
gcloud services enable places.googleapis.com apikeys.googleapis.com --project="$GCP_PROJECT" --quiet >/dev/null 2>&1

# Rotate the dedicated key on every deploy. The old key may have appeared in terminal output.
OLD_KEYS="$(gcloud services api-keys list --project="$GCP_PROJECT" --filter="displayName='$KEY_DISPLAY'" --format="value(name)")"
if [[ -n "$OLD_KEYS" ]]; then
  echo "Rotating dedicated Places-only key..."
  while IFS= read -r key_resource; do
    [[ -z "$key_resource" ]] && continue
    gcloud services api-keys delete "$key_resource" --project="$GCP_PROJECT" --quiet >/dev/null 2>&1 || true
  done <<< "$OLD_KEYS"
fi

echo "Creating fresh dedicated Places-only API key..."
gcloud services api-keys create \
  --project="$GCP_PROJECT" \
  --display-name="$KEY_DISPLAY" \
  --api-target=service=places.googleapis.com \
  --quiet >/dev/null 2>&1

KEY_RESOURCE="$(gcloud services api-keys list --project="$GCP_PROJECT" --filter="displayName='$KEY_DISPLAY'" --format="value(name)" | head -n1)"
if [[ -z "$KEY_RESOURCE" ]]; then
  echo "ERROR: could not locate fresh API key resource after creation."
  exit 1
fi

KEY_STRING="$(gcloud services api-keys get-key-string "$KEY_RESOURCE" --project="$GCP_PROJECT" --format="value(keyString)" 2>/dev/null)"
if [[ -z "$KEY_STRING" ]]; then
  echo "ERROR: could not retrieve API key string."
  exit 1
fi

echo "Fresh Google key ready and restricted to Places API. Secret not printed."

rm -rf "$WORKDIR"
git clone --depth 1 "$REPO_URL" "$WORKDIR" >/dev/null 2>&1
cd "$WORKDIR/tools/afy-free-rank-gateway"

if ! npx --yes vercel@latest whoami >/dev/null 2>&1; then
  echo
  echo "Vercel login is required. Follow the prompt once."
  npx --yes vercel@latest login
fi

echo "Vercel user: $(npx --yes vercel@latest whoami)"

npx --yes vercel@latest project add "$VERCEL_PROJECT" --scope "$VERCEL_SCOPE" >/dev/null 2>&1 || true
npx --yes vercel@latest link --yes --project "$VERCEL_PROJECT" --scope "$VERCEL_SCOPE" >/dev/null

npx --yes vercel@latest env rm GOOGLE_MAPS_API_KEY production --yes --scope "$VERCEL_SCOPE" >/dev/null 2>&1 || true
printf '%s\n' "$KEY_STRING" | npx --yes vercel@latest env add GOOGLE_MAPS_API_KEY production --scope "$VERCEL_SCOPE" >/dev/null
unset KEY_STRING

echo
echo "Deploying production gateway..."
DEPLOY_OUTPUT="$(npx --yes vercel@latest deploy --prod --yes --scope "$VERCEL_SCOPE" 2>&1)"
echo "$DEPLOY_OUTPUT"

DEPLOY_URL="$(printf '%s\n' "$DEPLOY_OUTPUT" | grep -Eo 'https://[^ ]+\.vercel\.app' | tail -n1)"
if [[ -z "$DEPLOY_URL" ]]; then
  DEPLOY_URL="https://afy-free-rank-gateway.vercel.app"
fi

echo
echo "HEALTH TEST"
curl -fsS "$DEPLOY_URL/api/health"
echo

echo
echo "IDS-ONLY TEST"
curl -fsS --get --data-urlencode "q=electrician in Clay County, Illinois" "$DEPLOY_URL/api/rank-ids" | python3 -m json.tool

echo
echo "AFY FREE RANK GATEWAY DEPLOY COMPLETE"
echo "URL: $DEPLOY_URL"
