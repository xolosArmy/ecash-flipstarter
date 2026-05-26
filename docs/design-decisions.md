# Design Decisions (ADR-style Notes)

- Use recursive covenant UTXO instead of mega transaction; enables independent pledges without ANYONECANPAY.
- Introspection opcodes are required to inspect outputs for covenant continuity and beneficiary payouts.
- 64-bit integers are used for goal and expiry to align with eCash consensus.
- Refund path does not constrain refund recipient for MVP; identity enforcement can be added later.
- Backend builds unsigned transactions; wallets sign locally to remain non-custodial.

## Backend plumbing (RPC + signing model)
- Transaction construction now uses @ecash/lib placeholders plus JSON-RPC via `ecashClient.ts`; RPC credentials are read from env (`E_CASH_RPC_*`/`ECASH_RPC_*`).
- CovenantIndex remains an in-memory map; TODO: swap for persistent DB or Chronik/indexer-backed source of truth.
- All transactions returned by the API are UNSIGNED. Client wallets (e.g., Tonalli/RMZWallet) must sign inputs and broadcast; backend only assists with construction.

## Chronik backend option
- Set `E_CASH_BACKEND=chronik` and `CHRONIK_BASE_URL=https://chronik.e.cash` (default, append `/xec` if your proxy requires it) to fetch UTXOs via `/script/{type}/{hash}/utxos` and broadcast via `/broadcast-tx` on Chronik.
- Leave unset or `rpc` to use node JSON-RPC as before; covenant logic and txBuilder are unchanged, only the UTXO/broadcast backend switches.

## Backend authority boundaries
- Backend state is a cache/index over verified eCash chain state. The blockchain covenant UTXOs and Chronik/RPC transaction data are the source of truth.
- SQLite must remain reconstructible from chain data plus campaign metadata. Pledge intents are local UX state only and must not be treated as confirmed funds.
- Confirmed campaign totals must be derived from verified pledge transactions that pay the expected covenant script/address with sufficient value.
- Temporary V1 backend-signed refunds are an operational stopgap. The long-term direction is user-claimable covenant refunds so the backend does not hold refund authority.
- Campaign finalization should remain externally verifiable from covenant UTXOs, campaign rules, and confirmed pledge transactions.

See [v2-decentralization-roadmap.md](/home/xolos-ramirez/ecashschool/ecash-flipstarter/docs/v2-decentralization-roadmap.md) for the detailed migration plan and V2 target architecture.
