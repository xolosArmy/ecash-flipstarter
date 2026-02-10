# Flipstarter 2.0 – Covenant-based Crowdfunding on eCash (XEC)

Monorepo for a covenant-driven crowdfunding system on eCash. Contracts, backend services, and frontend UI live here.

## Quickstart
1. Copy and edit `backend/.env.example` to `backend/.env`.
2. Backend:
   ```
   cd backend
   npm install
   npm run dev
   ```
4. Frontend:
   ```
   cd frontend
   npm install
   cp .env.local.example .env.local
   export VITE_API_BASE_URL=http://127.0.0.1:3001/api
   export VITE_TONALLI_BASE_URL=http://127.0.0.1:5174
   npm run dev
   ```

## Dev
Backend:
```
cd backend
npm install
npm run dev
```
(Escucha en http://127.0.0.1:3001)

Frontend:
```
cd frontend
npm install
npm run dev
```
(Vite en http://localhost:5173 con proxy /api -> 127.0.0.1:3001)

Test:
```
curl -i http://127.0.0.1:3001/api/campaigns
```

## Backend (Chronik mode)
```
cd backend
export E_CASH_BACKEND=chronik
export CHRONIK_URL=https://chronik.e.cash
npm run dev
```

## Flow
- Create campaign -> pledge -> open Tonalli -> return with txid.
- Create a campaign via `POST /api/campaign`.
- Fetch campaign details via `GET /api/campaign/:id`.
- Build pledge/finalize/refund unsigned txs via respective POST routes.
- Sign with Tonalli (external-sign), then return to `/tonalli-callback` with the txid.
- Broadcast via `POST /api/tx/broadcast` for manual signed hex.

## Docs
- Whitepaper placeholder: `docs/whitepaper/crowdfunding-covenant-xec-es.md`
- UTXO state machine: `docs/diagrams/utxo-state-machine.md`
- API reference: `docs/api.md`

## Configuración de Entorno
**E_CASH_BACKEND** = Selección del backend de blockchain. Valores: `"rpc"`, `"chronik"` o `"mock"`. Si no hay variables RPC, usa `chronik` por defecto en dev.

**ECASH_RPC_URL**, **ECASH_RPC_USER**, **ECASH_RPC_PASS** = Credenciales RPC del nodo eCash (usadas en modo `rpc`, y para funciones auxiliares en modo `chronik`).

**CHRONIK_URL** = URL base del API Chronik cuando `E_CASH_BACKEND=chronik` (por defecto `https://chronik.e.cash`). No uses esquema `wss://` aquí.

**CORS_ORIGINS** = Orígenes permitidos para CORS en el backend. En producción, configura tu dominio (ej. `https://cartera.xolosarmy.xyz`), separado por comas.
**CORS_ALLOW_DEV_LOCALHOST** = Permite orígenes locales (localhost/127.0.0.1) en desarrollo. Default: `true` en dev.

**PORT** = Puerto del backend (por defecto 3001).

Frontend:
**VITE_API_BASE_URL** = API base URL para el backend.
**VITE_TONALLI_BASE_URL** = URL base de Tonalli para el deeplink `/#/external-sign`.
**VITE_TONALLI_CALLBACK_URL** = URL opcional para sobrescribir el callback de Tonalli. Si no coincide con el origen actual en dev, se usa el origen en runtime.
**VITE_WC_PROJECT_ID** = Project ID de WalletConnect Cloud (requerido para WC v2).
**VITE_WC_APP_NAME** = Nombre mostrado en metadata de WalletConnect.
**VITE_WC_APP_URL** = URL pública de la app (metadata de WalletConnect, ej. `http://localhost:5174`).

## Local test plan
Backend:
```
cd backend
cp .env.example .env
npm install
npm run dev
```

Frontend:
```
cd frontend
npm install
export VITE_API_BASE_URL=http://127.0.0.1:3001/api
export VITE_TONALLI_BASE_URL=http://127.0.0.1:5174
npm run dev
```

Health:
```
curl http://localhost:3001/api/health
```

Create campaign:
```
curl -X POST http://localhost:3001/api/campaign \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Campaña Demo",
    "description": "Demo",
    "goal": "100000",
    "expirationTime": "1719871200",
    "beneficiaryAddress": "ecash:qqf4h2w8c2u2e2c5aqevwsvy2kyx5kqglc2j8v9u7f"
  }'
```

Open the campaign in the UI:
```
http://localhost:5173/campaign/<id>
```

Tonalli flow:
```
Open pledge -> Open Tonalli to Sign & Broadcast -> return to /#/tonalli-callback?campaignId=<id>&txid=<txid>
```

WalletConnect flow (nuevo):
- Configura `VITE_WC_PROJECT_ID`, `VITE_WC_APP_NAME` y `VITE_WC_APP_URL`.
- Conecta Tonalli con QR en la página de campaña.
- Al donar, se crea un offer con `POST /api/campaigns/:id/pledge/build` y se envía `ecash_signAndBroadcastTransaction` con `offerId`.
- Tonalli debe tratar `offerId` como UUID opaco y resolverlo con `GET /api/walletconnect/offers/:offerId`.

Build pledge tx (unsigned):
```
curl -X POST http://localhost:3001/api/campaign/<id>/pledge \
  -H 'Content-Type: application/json' \
  -d '{
    "contributorAddress": "ecash:qqf4h2w8c2u2e2c5aqevwsvy2kyx5kqglc2j8v9u7f",
    "amount": "1000"
  }'
```

Resolve WalletConnect offer (para Tonalli):
```
curl http://localhost:3001/api/walletconnect/offers/<offerId>
```

Sign the unsigned hex with Tonalli or another tool, then broadcast:
```
curl -X POST http://localhost:3001/api/tx/broadcast \
  -H 'Content-Type: application/json' \
  -d '{"rawTxHex":"<signed-hex>"}'
```

## Smoke test
A minimal end-to-end script to verify the backend flow (Chronik mode, campaign creation, pledge build, optional broadcast).

Required env vars:
- `CONTRIBUTOR_ADDRESS`
- `BENEFICIARY_ADDRESS`

Example:
```
CONTRIBUTOR_ADDRESS="ecash:..." BENEFICIARY_ADDRESS="ecash:..." ./scripts/smoke-test.sh
```

Optional broadcast:
```
SIGNED_TX_HEX="..." ./scripts/smoke-test.sh
```

If you see `EADDRINUSE`, stop the existing process or change `PORT` (backend) or the Vite port (frontend) before retrying.

## Local dev ports + CORS checks
- Backend: `http://127.0.0.1:3001`
- Wallet (RMZ/Tonalli local): `http://127.0.0.1:5174`
- Frontend (Vite): `http://127.0.0.1:5173` or `http://127.0.0.1:5175` if 5173 is taken (callback uses runtime origin)

Validate CORS:
```
curl -i -H "Origin: http://127.0.0.1:5175" http://127.0.0.1:3001/api/health
curl -i -X OPTIONS -H "Origin: http://127.0.0.1:5175" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type" http://127.0.0.1:3001/api/campaign
```
