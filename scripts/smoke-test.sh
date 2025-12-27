#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3001/api}"
CHRONIK_BASE_URL="${CHRONIK_BASE_URL:-https://chronik.xolosarmy.xyz/xec}"
CONTRIBUTOR_ADDRESS="${CONTRIBUTOR_ADDRESS:-}"
BENEFICIARY_ADDRESS="${BENEFICIARY_ADDRESS:-}"
GOAL_SATS="${GOAL_SATS:-100000}"
PLEDGE_SATS="${PLEDGE_SATS:-2000}"
EXPIRATION_SECONDS_FROM_NOW="${EXPIRATION_SECONDS_FROM_NOW:-3600}"
SIGNED_TX_HEX="${SIGNED_TX_HEX-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    if [ "$1" = "jq" ]; then
      echo "Install jq: https://stedolan.github.io/jq/download/" >&2
    fi
    exit 1
  fi
}

require_env() {
  if [ -z "$2" ]; then
    echo "Missing required env var: $1" >&2
    exit 1
  fi
}

now_epoch() {
  if date -d "@0" >/dev/null 2>&1; then
    date +%s
  else
    date -u +%s
  fi
}

add_seconds() {
  local base="$1"
  local delta="$2"
  if date -d "@0" >/dev/null 2>&1; then
    date -d "@$((base + delta))" +%s
  else
    date -u -r "$base" -v+"$delta"S +%s
  fi
}

require_cmd curl
require_cmd jq
require_env CONTRIBUTOR_ADDRESS "$CONTRIBUTOR_ADDRESS"
require_env BENEFICIARY_ADDRESS "$BENEFICIARY_ADDRESS"

echo "API_BASE_URL: $API_BASE_URL"
echo "CHRONIK_BASE_URL (info): $CHRONIK_BASE_URL"

health_json="$(curl -sS -f "${API_BASE_URL}/health")"
echo "$health_json" | jq -e '.status == "ok"' >/dev/null
backend_mode="$(echo "$health_json" | jq -r '.backendMode // "unknown"')"
tip_height="$(echo "$health_json" | jq -r '.tipHeight // 0')"
if [ "$backend_mode" != "chronik" ]; then
  echo "Warning: backendMode is $backend_mode (expected chronik)" >&2
fi
echo "$health_json" | jq -e '(.tipHeight | tonumber) > 0' >/dev/null
echo "Health OK. tipHeight=$tip_height backendMode=$backend_mode"

now_ts="$(now_epoch)"
expiration_time="$(add_seconds "$now_ts" "$EXPIRATION_SECONDS_FROM_NOW")"

campaign_payload="$(jq -n \
  --arg name "Smoke Test Campaign" \
  --arg description "Smoke test via script" \
  --argjson goal "$GOAL_SATS" \
  --argjson expirationTime "$expiration_time" \
  --arg beneficiaryAddress "$BENEFICIARY_ADDRESS" \
  '{name:$name,description:$description,goal:$goal,expirationTime:$expirationTime,beneficiaryAddress:$beneficiaryAddress}')"

campaign_json="$(curl -sS -f -X POST "${API_BASE_URL}/campaign" \
  -H 'Content-Type: application/json' \
  -d "$campaign_payload")"

campaign_id="$(echo "$campaign_json" | jq -r '.id // .campaignId // empty')"
if [ -z "$campaign_id" ]; then
  echo "Failed to read campaign id from response:" >&2
  echo "$campaign_json" >&2
  exit 1
fi
echo "Created campaign: $campaign_id"

campaign_detail="$(curl -sS -f "${API_BASE_URL}/campaign/${campaign_id}")"
echo "Campaign detail:"
echo "$campaign_detail" | jq '{id, name, goal, expirationTime, beneficiaryAddress, progress}'

pledge_payload="$(jq -n \
  --arg contributorAddress "$CONTRIBUTOR_ADDRESS" \
  --argjson amount "$PLEDGE_SATS" \
  '{contributorAddress:$contributorAddress,amount:$amount}')"

pledge_json="$(curl -sS -f -X POST "${API_BASE_URL}/campaign/${campaign_id}/pledge" \
  -H 'Content-Type: application/json' \
  -d "$pledge_payload")"

unsigned_hex="$(echo "$pledge_json" | jq -r '.unsignedTxHex // .rawHex // empty')"
if [ -z "$unsigned_hex" ]; then
  echo "Failed to read unsigned tx hex from response:" >&2
  echo "$pledge_json" >&2
  exit 1
fi

outfile="/tmp/flipstarter_unsigned.hex"
if [ ! -w "/tmp" ]; then
  mkdir -p ./tmp
  outfile="./tmp/flipstarter_unsigned.hex"
fi
printf "%s" "$unsigned_hex" > "$outfile"

echo "Unsigned tx hex:"
echo "$unsigned_hex"
echo "Saved to: $outfile"
echo "Sign this hex using Tonalli or your signing tool, then set SIGNED_TX_HEX or paste it below."

if [ -z "$SIGNED_TX_HEX" ]; then
  echo -n "Signed tx hex (leave empty to skip broadcast): "
  read -r SIGNED_TX_HEX
fi

if [ -n "$SIGNED_TX_HEX" ]; then
  broadcast_payload="$(jq -n --arg rawTxHex "$SIGNED_TX_HEX" '{rawTxHex:$rawTxHex}')"
  broadcast_json="$(curl -sS -f -X POST "${API_BASE_URL}/tx/broadcast" \
    -H 'Content-Type: application/json' \
    -d "$broadcast_payload")"
  txid="$(echo "$broadcast_json" | jq -r '.txid // empty')"
  if [ -z "$txid" ]; then
    echo "Broadcast failed:" >&2
    echo "$broadcast_json" >&2
    exit 1
  fi
  echo "Broadcasted TXID: $txid"
else
  echo "Skipped broadcast."
fi
