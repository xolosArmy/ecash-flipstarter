# Teyolia V2 Decentralization Roadmap

This document defines the technical direction for moving Teyolia / `ecash-flipstarter` from a hardened but still authoritative backend toward a chain-first model.

The target is not "fully decentralized" today. The system should only be described that way after backend refund-signing authority and backend payout discretion are removed from the critical path.

## Scope and non-goals

Scope:
- Move campaign truth from SQLite and backend decisions to eCash covenant UTXOs plus Chronik-derived history.
- Make refunds user-claimable from covenant rules instead of backend-signed.
- Make campaign success/failure and finalization externally verifiable from chain data.

Non-goals for the first V2 rollout:
- Removing all backend APIs.
- Eliminating all frontend wallet flow state.
- Hiding the fact that V1 campaigns still depend on backend authority.

## Current V1 trust assumptions

Today the backend is hardened, but it still has authority in several places:

1. Pledge verification
- The backend verifies whether a submitted `txid` should count as a pledge.
- Current verification checks are useful and should remain, but they are still mediated by backend code and stored state.

2. Refund eligibility
- The backend decides whether a pledge is refundable based on campaign expiry, campaign totals, pledge status, and local records.
- This is safer than blind refunds, but it still leaves a server-side policy layer between contributor and funds.

3. Refund signing and broadcasting
- V1 refund flow still depends on backend-held refund signing power (`refundOraclePrivKey` / `refundOraclePubKey` flow).
- The backend currently constructs, signs, and broadcasts refund spends for V1-style campaigns.

4. Campaign state storage
- SQLite stores indexed and cached campaign state, pledge records, totals, status transitions, and audit logs.
- This cache is operationally useful, but it is still treated as an authoritative source in too many places.

5. Contributor identity
- `contributorAddress` is trusted from the wallet flow at pledge creation time.
- The backend verifies later that a refund goes back to the recorded contributor address, but the binding is still partly off-chain and database-dependent.

## Desired V2 architecture

V2 should move to the following model:

1. Backend role
- Backend becomes an indexer, cache, API adapter, and transaction-construction helper.
- Backend must not have arbitrary discretion over refund or payout eligibility.
- Backend responses should clearly distinguish cached interpretation from raw verified chain state.

2. Source of truth
- Campaign state must be reconstructible from Chronik plus immutable campaign metadata.
- Pledge UTXOs and their spends become the source of truth for funds, not SQLite rows.
- SQLite becomes disposable. Deleting it must not destroy campaign correctness.

3. Refund authority
- Refunds become user-claimable covenant spends.
- Backend may help build unsigned transactions, but must not be required to authorize the spend.

4. Finalization authority
- Campaign success must be provable from covenant state transitions and chain-confirmed value progression.
- Finalization must be valid because the covenant rules allow it, not because the backend decides to allow it.

5. Verifiability standard
- A third party with campaign metadata and Chronik access should be able to derive:
- current covenant UTXO set
- confirmed contributed value
- whether expiry has passed
- whether refund path is open
- whether finalization has already happened

## Required V2 on-chain model

V2 needs enough on-chain identity to reconstruct state without trusting local pledge rows.

Required identifiers:
- `campaignId`: stable application identifier included in campaign metadata and derivable covenant context.
- `contractVersion`: explicit version so indexers know which covenant rules apply.
- `campaignScriptHash` and `campaignScriptPubKey`: canonical covenant identity.
- `beneficiaryAddress` or beneficiary locking script: immutable payout destination.
- `goalSats`: immutable funding threshold.
- `expiryTimestamp`: immutable refund/failure threshold.

Recommended pledge-level identifiers:
- Contributor refund locking script committed in the pledge construction, not just a frontend-provided address string.
- Optional `pledgeNonce` or deterministic outpoint-based identity if needed for deduplication and frontend UX.

## Refund redesign

### Objective

Replace backend-signed refunds with a user-claimable covenant refund path.

### High-level design

Each accepted pledge must commit the contributor's refund destination in a way the covenant can enforce during refund spends. After expiry and failure, the contributor should be able to spend their refundable portion without backend signatures.

Two acceptable patterns:

1. Per-pledge covenant outputs
- Each pledge creates or preserves a distinct UTXO that commits to:
- campaign rules
- contributor refund script
- pledge amount or refund share
- Refund is simple because the contributor claims against their own pledge UTXO.
- Tradeoff: more UTXOs and more expensive aggregation/finalization.

2. Aggregate covenant with contributor commitments
- The covenant tracks multiple contributors inside an aggregate state transition model.
- Refund spends must prove inclusion and entitlement for one contributor.
- Tradeoff: better aggregation, much harder covenant and indexer design.

Recommendation:
- Prefer per-pledge or per-contributor claimable outputs for the first V2 design.
- It is less elegant than a fully aggregated state machine, but much more realistic to audit, index, and test.

### Frontend data needed to build a refund transaction

To let a contributor build a refund transaction, the frontend needs:
- `campaignId`
- `contractVersion`
- refund-claimable UTXO outpoint(s): `txid`, `vout`, `valueSats`
- covenant locking script or script template reference
- contributor refund script or normalized `contributorAddress`
- `expiryTimestamp`
- campaign `goalSats`
- proof that finalization has not already consumed the refundable UTXO
- fee estimate inputs or a backend helper that returns a fee quote without signing

If the frontend cannot derive these directly, the backend may return them as indexed chain data, but the user must be able to verify them against Chronik.

### Expiry and goal-failure conditions

Refund path should open only when all of the following are true:
- chain height / median time past / locktime condition satisfies `expiryTimestamp`
- the campaign has not been validly finalized
- the campaign did not reach a valid success condition before expiry, or the covenant explicitly defines success at finalization time only

Important design choice:
- V2 must define whether "goal reached in accumulation UTXO before expiry" immediately disables refunds, or whether only a valid finalization transaction disables refunds.

Recommendation:
- Disable refunds once success is provable from covenant rules and chain state, not from backend totals.
- The exact success trigger must be written into the covenant semantics and documented clearly.

### Contributor identity enforcement

Do not rely on a backend pledge record alone.

V2 should enforce contributor refund destination by one of these methods:
- Commit a refund locking script directly in each pledge output.
- Commit a contributor pubkey or pubkey hash and require the refund output to pay that script.
- If a separate wallet-change output is involved, commit the refund destination in the covenant spend arguments or script-visible outputs.

Recommendation:
- Bind each pledge to a refund script hash at construction time.
- Treat frontend `contributorAddress` as a wallet UX input only; the enforceable identity is the committed locking script.

## Payout and finalization redesign

### Campaign success proof

Campaign success must be derivable from confirmed chain data and covenant rules.

Success proof should be:
- the covenant-controlled value at or above `goalSats`
- before or at the covenant-allowed finalization time
- with a valid finalization transaction that pays the committed beneficiary script

The backend may publish a "campaign succeeded" interpretation, but that statement must be independently checkable from the finalization transaction and prior covenant UTXO chain.

### Pledge aggregation

V2 needs a defined rule for how pledge UTXOs are combined:
- If using recursive accumulation, each pledge spend must recreate the canonical campaign covenant output with monotonically non-decreasing campaign value.
- If using per-pledge refundable outputs plus a campaign accumulator, each pledge must update the accumulator and preserve the contributor's refundable claim.

Recommendation:
- Use an explicit state transition model:
- `INIT -> ACCUMULATION`
- `ACCUMULATION -> ACCUMULATION`
- `ACCUMULATION -> FINALIZED`
- `ACCUMULATION -> EXPIRED_REFUNDABLE`

Each transition must be inferable from the transaction graph, not from SQLite status.

### Beneficiary payout

Project funds should reach the project address through a covenant-valid finalization transaction that:
- consumes the valid campaign-controlled UTXO set
- produces the beneficiary output to the committed beneficiary script
- leaves no ambiguous discretionary recipient chosen by backend request parameters

Backend-supplied beneficiary overrides should not exist in V2 unless the covenant explicitly allows them and they are provable from chain rules. The safer default is no override.

### Invalid or duplicate pledge attempts

V2 must distinguish wallet intent from accepted on-chain pledge state.

Duplicate or invalid attempts are excluded by these rules:
- Only transactions that create the expected covenant state transition count as accepted pledges.
- A duplicate frontend submission without a valid new chain transition remains local intent only.
- A repeated `txid` cannot count twice.
- A transaction paying the wrong script, wrong amount semantics, or violating the covenant transition is ignored as funding state.

The backend may still track wallet intents for UX, but they must be marked as non-authoritative and never merged into verified totals.

## Reindexing model

### Goal

After deleting SQLite, the backend should be able to rebuild campaign state by scanning Chronik data for known campaign scripts and finalization/refund spends.

### Rebuild procedure

For each campaign:

1. Load immutable campaign metadata
- `campaignId`
- `contractVersion`
- `campaignScriptHash`
- `campaignScriptPubKey`
- `goalSats`
- `expiryTimestamp`
- beneficiary script/address

2. Query Chronik for:
- current and spent UTXOs for the campaign script hash
- transactions paying to the campaign covenant script
- transactions spending prior campaign covenant UTXOs
- finalization transactions paying the beneficiary script
- refund transactions spending refundable pledge outputs

3. Reconstruct the transaction graph
- identify the deployment UTXO
- follow each valid covenant state transition
- identify finalization or refund terminal paths

4. Derive chain state
- confirmed contribution total
- current unspent refundable covenant value
- refunded amount
- finalized amount
- whether the campaign is still pending, expired, refunded-out, or finalized

### Required on-chain identifiers for reindexing

At minimum the indexer must know:
- the canonical covenant script hash
- campaign creation transaction or deployment outpoint
- contract version
- beneficiary locking script
- goal and expiry parameters

Without those identifiers, SQLite deletion would force trust in prior backend records.

### Canonical state definitions

These states should be defined from chain data, not local flags:

- `pending`: wallet intent exists locally, but no valid on-chain pledge transition is confirmed.
- `confirmed`: valid pledge transition confirmed on-chain and still part of the active campaign-controlled state.
- `expired`: expiry condition satisfied, campaign not finalized, refundable path open for remaining refundable outputs.
- `refunded`: a contributor's refundable claim has been spent to the committed refund destination.
- `finalized`: campaign funds have been consumed by a valid finalization transaction paying the committed beneficiary.

Additional implementation note:
- `seen_mempool` can remain a cache/indexer status, but it is not final chain truth.

## API changes

### Principle

Separate cached backend state from verified chain state in both naming and payload structure.

Recommended payload shape:

```json
{
  "campaignId": "example",
  "cacheState": {
    "walletIntentCount": 2,
    "lastIndexedAt": "2026-05-25T00:00:00.000Z"
  },
  "chainState": {
    "confirmedTotalSats": 100000,
    "pendingTotalSats": 25000,
    "refundableTotalSats": 40000,
    "finalizedTotalSats": 60000,
    "status": "expired"
  }
}
```

Required clear fields:
- `confirmedTotalSats`
- `pendingTotalSats`
- `refundableTotalSats`
- `finalizedTotalSats`

Field migration guidance:
- Deprecate ambiguous fields like `amount`, `goal`, `totalPledged`, or `totalRaised` where units or trust domain are unclear.
- Prefer explicit sat-denominated fields such as `amountSats`, `goalSats`, `confirmedTotalSats`.
- If legacy fields remain temporarily, document whether they are:
- cached UX state
- chain-verified state
- mixed legacy behavior

Specific current ambiguity to remove:
- Frontend currently derives meaning from `totalPledged`, `pendingTotalPledged`, and per-pledge `amount`.
- V2 should rename or document these as `confirmedTotalSats`, `pendingTotalSats`, and `amountSats`.

## Testing roadmap

### Reindexing tests
- Add a test that wipes SQLite, replays Chronik-backed campaign history, and reproduces the same campaign chain state.
- Cover active, expired, refunded, and finalized campaigns.

### Refund construction tests
- Add tests that build user-claimable refund transactions from indexed chain data without backend signing keys.
- Verify refund output must match the contributor-committed script.

### Finalization safety tests
- Add tests proving a finalized campaign cannot later produce valid refunds.
- Add tests proving an expired refundable campaign cannot also produce a valid finalization path if covenant rules say the paths are exclusive.

### Success/failure reconstruction tests
- Add tests that reconstruct campaign success or failure strictly from chain data.
- Include cases where local pledge intents exist but never became valid on-chain pledges.
- Include duplicate `txid` submissions and wrong-script pledge attempts.

## Migration plan

### Phase 0: Keep V1 safe
- Keep the current hardened V1 path operational.
- Continue documenting backend-signed refunds as a trusted stopgap, not a decentralized final design.
- Do not weaken existing verification just to accelerate V2.

### Phase 1: Introduce chain-first read model
- Add V2 indexing and reconstruction logic first.
- Expose chain-derived totals alongside legacy cached totals.
- Make SQLite disposable for reads before changing spend authority.

### Phase 2: Introduce V2 claimable refund path
- Add new campaign contract version with contributor-bound refund claims.
- Keep V1 backend-signed refund flow for existing campaigns only.
- Mark backend-signed refunds as deprecated in docs and API responses.

### Phase 3: Introduce V2 covenant-verifiable finalization
- Remove beneficiary override behavior from V2 flows.
- Require payout construction to target the beneficiary script committed by the covenant.
- Ensure finalization and refund exclusivity is enforced by covenant rules, not backend policy.

### Phase 4: Deprecate V1 operational authority
- Stop creating new V1 campaigns once V2 is tested in staging and testnet-like conditions.
- Keep V1 support for existing campaigns until operationally safe to retire.
- Do not remove V1 code paths until V2 reindexing, refund claiming, and finalization behavior are all tested.

## Honest status statement

Teyolia is moving toward a decentralized, chain-verifiable crowdfunding model, but it is not there yet. As long as the backend can decide refund execution or holds signing authority for refund spends, decentralization is incomplete. V2 should be described as a decentralization roadmap and partial architectural transition until those authorities are removed.
