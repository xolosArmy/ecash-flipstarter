# Flipstarter 2.0 API

Base path: `/api`

## POST /api/campaign
- Body: `{ name, description, goal, expirationTime, beneficiaryAddress }`
- Response: `{ campaignId, scriptHash, scriptHex, covenant: { txid, vout, value, scriptHash, scriptPubKey } }`

## GET /api/campaign/:id
- Response: metadata + `covenant` reference + `progress` (value/goal when available).

## POST /api/campaign/:id/pledge
- Body: `{ contributorAddress, amount }`
- Response: `{ unsignedTx, rawHex, unsignedTxHex }` (unsigned transaction) plus any fee/change metadata if available.

## POST /api/campaign/:id/finalize
- **Disabled by default (P7A-07).** Requires `ENABLE_CAMPAIGN_FINALIZE=true` (exact, case-sensitive string; any other value or an unset variable keeps it disabled). When disabled it responds `403` with `{ "error": "campaign-finalize-disabled", "code": "campaign-finalize-disabled" }` before reading the body, the campaign or any signing key.
- The same flag gates the aliases `POST /api/campaigns/:id/finalize-request`, `POST /api/campaign/:id/finalize-request` and `POST /api/campaigns/:id/payout/build` (they reach the same signing path).
- Body: `{ beneficiaryAddress? }` (optional override if allowed)
- Response: `{ unsignedTx, rawHex }` (unsigned transaction to beneficiary).

## POST /api/campaign/:id/refund
- Body: `{ refundAddress, refundAmount }`
- Response: `{ unsignedTx, rawHex }` (unsigned refund transaction).

## POST /api/tx/broadcast
- **Disabled by default (P7A-07).** Requires `ENABLE_PUBLIC_BROADCAST=true` (exact, case-sensitive string; any other value or an unset variable keeps it disabled). When disabled it responds `403` with `{ "error": "public-broadcast-disabled", "code": "public-broadcast-disabled" }` and nothing is broadcast.
- The same flag gates the alias `POST /api/broadcast`.
- Body: `{ rawTxHex }`
- Response: `{ txid, backendMode, message }`

## Examples

Create a campaign:
```bash
curl -X POST http://localhost:3001/api/campaign \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Demo Campaign",
    "description": "Test covenant crowdfunding",
    "goal": 100000000,
    "expirationTime": 1735689600,
    "beneficiaryAddress": "ecash:qq..."
  }'
```

Create a pledge tx:
```bash
curl -X POST http://localhost:3001/api/campaign/campaign-123/pledge \
  -H 'Content-Type: application/json' \
  -d '{
    "contributorAddress": "ecash:qr...",
    "amount": 50000
  }'
```

### Chronik backend
For development you can set `E_CASH_BACKEND=chronik` and optionally `CHRONIK_BASE_URL` (default `https://chronik.e.cash`, may include `/xec` if your proxy requires it). In this mode:
- UTXOs come from `GET {CHRONIK_BASE_URL}/script/{type}/{hash}/utxos` (or `/address/{addr}/utxos`).
- Transactions broadcast via `POST {CHRONIK_BASE_URL}/broadcast-tx` with raw tx hex body.
