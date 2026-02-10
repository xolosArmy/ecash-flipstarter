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
npm install
export VITE_API_BASE_URL=http://127.0.0.1:3001/api
export VITE_TONALLI_BASE_URL=http://127.0.0.1:5174
npm run dev
```

## Build frontend
```bash
cd frontend
npm run build
```

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
