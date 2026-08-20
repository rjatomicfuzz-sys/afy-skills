#!/usr/bin/env bash
set -euo pipefail

GCP_PROJECT="big-command-495016-i9"
REQUIRED_ACCOUNT="hello@automaticforyou.com"
VERCEL_SCOPE="rjatomicfuzz-7072s-projects"
VERCEL_PROJECT="afy-free-rank-gateway"
STABLE_URL="https://afy-free-rank-gateway.vercel.app"
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

ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)"
if [[ "$ACTIVE_ACCOUNT" != "$REQUIRED_ACCOUNT" ]]; then
  echo "ERROR: active Google account must be $REQUIRED_ACCOUNT"
  echo "Current active account: ${ACTIVE_ACCOUNT:-NONE}"
  exit 1
fi

gcloud config set project "$GCP_PROJECT" >/dev/null

echo
echo "Active Google account: $ACTIVE_ACCOUNT"

echo
echo "Enabling Places API + API Keys API..."
gcloud services enable places.googleapis.com apikeys.googleapis.com --project="$GCP_PROJECT" --quiet >/dev/null 2>&1

KEY_RESOURCE="$(gcloud services api-keys list --project="$GCP_PROJECT" --filter="displayName='$KEY_DISPLAY'" --format="value(name)" | head -n1)"
if [[ -z "$KEY_RESOURCE" ]]; then
  echo "Creating dedicated Places-only API key..."
  gcloud services api-keys create --project="$GCP_PROJECT" --display-name="$KEY_DISPLAY" --api-target=service=places.googleapis.com --quiet >/dev/null 2>&1
  KEY_RESOURCE="$(gcloud services api-keys list --project="$GCP_PROJECT" --filter="displayName='$KEY_DISPLAY'" --format="value(name)" | head -n1)"
else
  echo "Reusing dedicated key and re-applying Places-only restriction..."
  gcloud services api-keys update "$KEY_RESOURCE" --project="$GCP_PROJECT" --api-target=service=places.googleapis.com --quiet >/dev/null 2>&1
fi
[[ -n "$KEY_RESOURCE" ]] || { echo "ERROR: could not locate API key resource."; exit 1; }
KEY_STRING="$(gcloud services api-keys get-key-string "$KEY_RESOURCE" --project="$GCP_PROJECT" --format="value(keyString)" 2>/dev/null)"
[[ -n "$KEY_STRING" ]] || { echo "ERROR: could not retrieve API key string."; exit 1; }
echo "Google key ready and restricted to Places API. Secret not printed."

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
npx --yes vercel@latest deploy --prod --yes --scope "$VERCEL_SCOPE"

echo
echo "Waiting for stable production alias..."
HEALTH_OK=0
for i in {1..30}; do
  STATUS="$(curl -sS -o /tmp/afy-health.json -w '%{http_code}' "$STABLE_URL/api/health" || true)"
  if [[ "$STATUS" == "200" ]] && grep -q '"ok":true' /tmp/afy-health.json; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done
[[ "$HEALTH_OK" == "1" ]] || { echo "ERROR: stable health route did not become ready."; cat /tmp/afy-health.json 2>/dev/null || true; exit 1; }

echo
echo "HEALTH TEST"
cat /tmp/afy-health.json
echo

echo
echo "IDS-ONLY TEST"
curl -fsS --get --data-urlencode "q=electrician in Clay County, Illinois" "$STABLE_URL/api/rank-ids" | python3 -m json.tool

echo
echo "PRO IDENTITY TEST"
PRO_OK=0
for i in {1..30}; do
  STATUS="$(curl -sS -o /tmp/afy-pro.json -w '%{http_code}' --get --data-urlencode "q=electrician in Clay County, Illinois" "$STABLE_URL/api/identity-pro" || true)"
  if [[ "$STATUS" == "200" ]] && grep -q '"ok":true' /tmp/afy-pro.json; then
    PRO_OK=1
    break
  fi
  sleep 2
done
if [[ "$PRO_OK" != "1" ]]; then
  echo "ERROR: Pro identity route did not become ready. Last HTTP status: $STATUS"
  cat /tmp/afy-pro.json 2>/dev/null || true
  exit 1
fi
python3 -m json.tool < /tmp/afy-pro.json

echo
echo "AFY FREE RANK GATEWAY DEPLOY COMPLETE"
echo "URL: $STABLE_URL"
