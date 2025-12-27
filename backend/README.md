# Flipstarter Backend

Express + TypeScript backend scaffold for Flipstarter 2.0. Provides campaign, pledge, finalize, and refund APIs backed by covenant transactions on eCash.

## Configuration

Chronik mode uses the base URL including the network suffix (e.g. `/xec`), for example:

```
E_CASH_BACKEND=chronik
CHRONIK_BASE_URL=https://chronik.xolosarmy.xyz/xec
API_PORT=3001
HOST=127.0.0.1
```

Quick checks:

```
curl http://127.0.0.1:3001/api/health
curl https://chronik.xolosarmy.xyz/xec/chronik-info
```

## Testing
Tests do not start a server; they call handlers directly to avoid socket binding restrictions.
