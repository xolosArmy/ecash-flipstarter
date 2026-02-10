# Flipstarter Backend

Express + TypeScript backend scaffold for Flipstarter 2.0. Provides campaign, pledge, finalize, and refund APIs backed by covenant transactions on eCash.

## Configuration

Chronik mode uses the base URL without the `/xec` suffix.

```
E_CASH_BACKEND=chronik
CHRONIK_URL=https://chronik.xolosarmy.xyz
PORT=3001
HOST=127.0.0.1
```

Quick checks:

```
curl http://127.0.0.1:3001/api/health
curl https://chronik.xolosarmy.xyz/chronik-info
```

## WalletConnect Offer Flow

- Build pledge offer: `POST /api/campaigns/:id/pledge/build` with `{ "contributorAddress": "ecash:...", "amount": 3000 }`.
- Backend creates an opaque UUID `wcOfferId` and stores the exact `unsignedTxHex`.
- Wallet side resolves offer data via `GET /api/walletconnect/offers/:offerId`.
- Wallet request method: `ecash_signAndBroadcastTransaction`.
- Expected params: `{ "offerId": "<uuid>", "userPrompt": "Donate to campaign", "keys": [] }`.
- `offerId` is opaque; do not parse as `txid:vout`.

## WS Dev Note

`curl /ws` returns `400` unless the client performs a websocket upgrade handshake. Use a websocket client (`wscat`, browser WS client, app wallet client) for WS tests.

## Testing
Tests do not start a server; they call handlers directly to avoid socket binding restrictions.
