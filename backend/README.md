# Flipstarter Backend

Express + TypeScript backend scaffold for Flipstarter 2.0. Provides campaign, pledge, activation fee, and payout APIs backed by covenant transactions on eCash.

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

## Activation Fee + Treasury env vars

- `TEYOLIA_SQLITE_PATH` (optional): override SQLite DB path. Leave unset in runtime to keep default `backend/data/campaigns.db`; useful in tests/CI for writable temp DB files.
- `TEYOLIA_ACTIVATION_FEE_XEC` (default `800000`): activation fee required before campaign can become `active`.
- `TEYOLIA_TREASURY_ADDRESS` (default `ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk`): treasury destination for activation fee and 1% funded payout cut.

## WalletConnect Offer Flow

- Build pledge offer: `POST /api/campaigns/:id/pledge/build` with `{ "contributorAddress": "ecash:...", "amount": 3000 }`.
- Build activation offer: `POST /api/campaigns/:id/activation/build` with `{ "payerAddress": "ecash:..." }`.
- Build payout offer: `POST /api/campaigns/:id/payout/build`.
- Activation build now returns `mode: "intent"` with `outputs` only (no `rawHex`, no inputs/change).
- Backend creates an opaque UUID `wcOfferId`; pledge/payout offers still include `unsignedTxHex` while activation uses intent payload.
- Wallet side resolves offer data via `GET /api/walletconnect/offers/:offerId`.
- Wallet request method: `ecash_signAndBroadcastTransaction`.

## WS Dev Note

`curl /ws` returns `400` unless the client performs a websocket upgrade handshake. Use a websocket client (`wscat`, browser WS client, app wallet client) for WS tests.

## Testing

Tests do not start a server; they call handlers directly to avoid socket binding restrictions.
