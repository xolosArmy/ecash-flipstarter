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
   export VITE_API_BASE_URL=http://localhost:3001/api
   npm run dev
   ```

## Flow
- Create a campaign via `POST /api/campaign`.
- Fetch campaign details via `GET /api/campaign/:id`.
- Build pledge/finalize/refund unsigned txs via respective POST routes.
- Sign with a wallet (Tonalli/RMZWallet planned); broadcast via `POST /api/tx/broadcast`.

## Docs
- Whitepaper placeholder: `docs/whitepaper/crowdfunding-covenant-xec-es.md`
- UTXO state machine: `docs/diagrams/utxo-state-machine.md`
- API reference: `docs/api.md`

## Configuración de Entorno
**E_CASH_BACKEND** = Selección del backend de blockchain. Valores: `"rpc"`, `"chronik"` o `"mock"`. Si no hay variables RPC, usa `chronik` por defecto en dev.

**ECASH_RPC_URL**, **ECASH_RPC_USER**, **ECASH_RPC_PASS** = Credenciales RPC del nodo eCash (usadas en modo `rpc`, y para funciones auxiliares en modo `chronik`).

**CHRONIK_BASE_URL** = URL base del API Chronik cuando `E_CASH_BACKEND=chronik` (por defecto `https://chronik.e.cash/xec`). Debe incluir el sufijo de red `/xec`.

**ALLOWED_ORIGIN** = Origen permitido para CORS en el backend. En producción, configura tu dominio (ej. `https://cartera.xolosarmy.xyz`); en desarrollo se usa `http://127.0.0.1:5173` si no se define.

**API_PORT** = Puerto del backend (por defecto 3001).

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
export VITE_API_BASE_URL=http://localhost:3001/api
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

Build pledge tx (unsigned):
```
curl -X POST http://localhost:3001/api/campaign/<id>/pledge \
  -H 'Content-Type: application/json' \
  -d '{
    "contributorAddress": "ecash:qqf4h2w8c2u2e2c5aqevwsvy2kyx5kqglc2j8v9u7f",
    "amount": "1000"
  }'
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

If you see `EADDRINUSE`, stop the existing process or change `API_PORT` (backend) or the Vite port (frontend) before retrying.
