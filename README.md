# Teyolia: El Renacimiento de Flipstarter

Teyolia es una implementación de crowdfunding no-custodial sobre eCash (XEC), con campañas tipo Flipstarter, flujo de firma con WalletConnect/Tonalli y payout condicionado al éxito.

## Qué incluye
- `frontend/`: interfaz React + TypeScript (creación guiada, pledges, activación, payout).
- `backend/`: API para campañas, pledges, activación y payout.
- `contracts/`: lógica de covenant y pruebas.
- `docs/`: documentos técnicos y whitepaper.

## Principios UX y seguridad
- Non-custodial: el usuario firma en su wallet.
- Nunca compartas seed o llave privada.
- Comisión del 1% solo cuando la campaña se fondea exitosamente.

## Persistencia de campañas (SQLite + compat JSON)
Desde esta versión, la fuente de verdad de campañas es SQLite (`backend/data/campaigns.db`) con compatibilidad gradual para `backend/data/campaigns.json`.

- Al arrancar backend:
1. Se inicializa SQLite.
2. Si SQLite está vacía y existe `campaigns.json`, se migra de forma idempotente.
3. Luego se hidrata el store en memoria (sin cambiar contratos API).

- Variables de entorno backend relacionadas:
1. `MIGRATE_ON_START=true` (default): permite migrar JSON -> SQLite automáticamente al arranque.
2. `CAMPAIGNS_DUAL_WRITE_JSON=true` (default): mantiene escritura dual SQLite + JSON para transición/ops.

- Migración manual:
```bash
cd backend
npm run migrate:campaigns
```

## WalletConnect v2 + Tonalli (RMZWallet)
Configuración esperada de namespace/método/chain:
- namespace: `ecash`
- chain: `ecash:1`
- method: `ecash_signAndBroadcastTransaction`

El frontend valida estos valores antes de firmar; si la sesión no los incluye, pedirá reconectar wallet.

## Project ID (Reown / WalletConnect Cloud)
Debes crear un Project ID en Reown (WalletConnect Cloud) y pasarlo como variable de entorno.

- Obtención:
1. Entra a Reown Cloud (WalletConnect Cloud).
2. Crea un proyecto para tu dApp.
3. Copia el Project ID.

- Variables frontend:
Requeridas:
1. `VITE_WC_PROJECT_ID=your_reown_project_id`
2. `VITE_TONALLI_BASE_URL=https://cartera.xolosarmy.xyz` (o `http://127.0.0.1:5175` en local)

Recomendadas:
1. `VITE_WC_APP_NAME=Flipstarter 2.0`
2. `VITE_WC_APP_URL=http://localhost:5174`

Opcionales (solo si usas flujo `external-sign`):
1. `VITE_TONALLI_BRIDGE_URL`
2. `VITE_TONALLI_BRIDGE_ORIGIN`
3. `VITE_TONALLI_BRIDGE_PATH`
4. `VITE_TONALLI_CALLBACK_URL`
5. `VITE_TONALLI_TIMEOUT_MS`

Tonalli es una app separada de Teyolia, por lo que `VITE_TONALLI_BASE_URL` no debe apuntar al mismo puerto del frontend.

- Seguridad:
1. No comitear `.env.local` ni secretos.
2. Usa valores por entorno (dev/staging/prod).

## Quickstart local
1. Backend:
```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

2. Frontend:
```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

## Persistencia de campañas (JSON + SQLite)
- Fuente principal de persistencia: `backend/data/campaigns.db` (SQLite).
- Compatibilidad legacy: se mantiene `backend/data/campaigns.json` con dual-write.
- En arranque, backend intenta cargar primero desde SQLite. Si está vacía, hace fallback a JSON y migra automáticamente.
- Para forzar migración manual:
```bash
cd backend
npm run migrate:campaigns
```

## WalletConnect v2 + Tonalli (RMZWallet)
### Variables de entorno
En frontend define:

**Requeridas**
- `VITE_WC_PROJECT_ID` (Project ID de Reown/WalletConnect Cloud).
- `VITE_TONALLI_BASE_URL` (base URL de Tonalli; Tonalli es una app separada de Teyolia).

**Recomendadas**
- `VITE_WC_APP_NAME`
- `VITE_WC_APP_URL`

**Opcionales (solo si usas external-sign/deep link)**
- `VITE_TONALLI_BRIDGE_URL`
- `VITE_TONALLI_BRIDGE_ORIGIN`
- `VITE_TONALLI_BRIDGE_PATH`
- `VITE_TONALLI_CALLBACK_URL`
- `VITE_TONALLI_TIMEOUT_MS`

> No comitees `.env.local` ni IDs reales de producción.

### Dónde obtener `VITE_WC_PROJECT_ID`
1. Crea cuenta en Reown/WalletConnect Cloud.
2. Crea un proyecto para la dApp.
3. Copia el **Project ID** y configúralo como `VITE_WC_PROJECT_ID`.

Si falta `VITE_WC_PROJECT_ID`, el frontend deshabilita “Conectar Tonalli” y muestra error claro.

### Smoke test manual: WalletConnect con Tonalli
1. Levanta backend y frontend.
2. Abre la dApp y pulsa **Conectar Tonalli (WalletConnect)**.
3. Escanea el QR/deeplink con Tonalli.
4. Verifica que la sesión solicite:
   - chain `ecash:1`
   - method `ecash_signAndBroadcastTransaction`
5. Ejecuta una acción de firma (activar campaña o payout).
6. Confirma que llega `txid` y cambia el estado de campaña.

### Sanity check de configuración WalletConnect
```bash
cd frontend
npm run test:wc-sanity
```
Valida estáticamente que el namespace solicitado contiene `ecash:1` y `ecash_signAndBroadcastTransaction`.

## Build frontend
```bash
cd frontend
npm run build
```

## Sanity check WalletConnect config
Valida estáticamente la configuración solicitada por la dApp:

```bash
cd frontend
npm run test:walletconnect:sanity
```

## Smoke test manual: WalletConnect con Tonalli
1. Levanta backend y frontend en local.
2. Configura `VITE_WC_PROJECT_ID` en `frontend/.env.local`.
3. Abre la app y haz click en `Conectar Tonalli (WalletConnect)`.
4. Escanea QR o abre deeplink en Tonalli.
5. Confirma que la sesión aprobada solicite `ecash_signAndBroadcastTransaction` en `ecash:1`.
6. Ejecuta una acción on-chain (por ejemplo activación de campaña).
7. Verifica respuesta con `txid` y cambio de estado de campaña.
8. Validación intent-only: al donar/activar con payload que solo trae `outputs`, RMZWallet debe abrir modal y firmar sin mostrar `Usa el formato txid:vout.`.

## Flujo básico
1. Crear campaña (borrador).
2. Pagar activación on-chain.
3. Recibir pledges.
4. Si se fondea, ejecutar payout (99% beneficiario, 1% infraestructura).

## Puertos comunes
- Backend: `http://127.0.0.1:3001`
- Frontend: `http://127.0.0.1:5173`

## Licencia
MIT (`LICENSE`).
