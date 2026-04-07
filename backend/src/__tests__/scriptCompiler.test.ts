import { describe, expect, it } from 'vitest';
import {
  OP,
  TEYOLIA_COVENANT_V1,
  bytesToHex,
  compileCampaignCovenantV1,
  compileCampaignScript,
  encodeScriptNum,
  hash160,
  p2pkhLockingBytecodeFromPubKeyHash,
  pushBytes,
  pushScriptNum,
} from '../covenants/scriptCompiler';

const BENEFICIARY_PUBKEY = `02${'11'.repeat(32)}`;
const REFUND_ORACLE_PUBKEY = `03${'22'.repeat(32)}`;

describe('compileCampaignCovenantV1', () => {
  it('produces deterministic redeem, script pubkey, and script hash hex', () => {
    const first = compileCampaignCovenantV1({
      goal: 125_000n,
      expirationTime: 1_735_689_600n,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
    });
    const second = compileCampaignCovenantV1({
      goal: 125_000n,
      expirationTime: 1_735_689_600n,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
    });

    expect(first.redeemScriptHex).toBe(second.redeemScriptHex);
    expect(first.scriptPubKeyHex).toBe(second.scriptPubKeyHex);
    expect(first.scriptHashHex).toBe(second.scriptHashHex);
  });

  it('derives the beneficiary locking bytecode from the beneficiary pubkey hash', () => {
    const compiled = compileCampaignCovenantV1({
      goal: 50_000n,
      expirationTime: 800_000n,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
    });

    expect(compiled.beneficiaryLockingBytecodeHex).toBe(
      p2pkhLockingBytecodeFromPubKeyHash(hash160(Buffer.from(BENEFICIARY_PUBKEY, 'hex')))
    );
  });

  it('includes the selector routing opcodes for finalize, refund, and pledge', () => {
    const compiled = compileCampaignCovenantV1({
      goal: 75_000n,
      expirationTime: 1_200_000n,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
    });

    expect(compiled.redeemScriptHex).toContain(bytesToHex([OP.OP_DUP, OP.OP_1, OP.OP_NUMEQUAL, OP.OP_IF]));
    expect(compiled.redeemScriptHex).toContain(bytesToHex([OP.OP_DUP, OP.OP_2, OP.OP_NUMEQUAL, OP.OP_IF]));
    expect(compiled.redeemScriptHex).toContain(bytesToHex([OP.OP_3, OP.OP_NUMEQUALVERIFY]));
  });

  it('encodes goal and expiration as minimally encoded Script Numbers', () => {
    const goal = 125_001n;
    const expirationTime = 1_735_689_601n;
    const compiled = compileCampaignCovenantV1({
      goal,
      expirationTime,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
    });

    expect(compiled.redeemScriptHex).toContain(bytesToHex(pushBytes(encodeScriptNum(goal))));
    expect(compiled.redeemScriptHex).toContain(bytesToHex(pushBytes(encodeScriptNum(expirationTime))));
  });

  it('normalizes millisecond expirations to seconds before encoding the refund branch', () => {
    const expirationTimeMs = 1_775_234_960_697n;
    const expirationTimeSeconds = 1_775_234_960n;
    const compiled = compileCampaignCovenantV1({
      goal: 125_001n,
      expirationTime: expirationTimeMs,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
    });

    expect(compiled.redeemScriptHex).toContain(bytesToHex(pushBytes(encodeScriptNum(expirationTimeSeconds))));
    expect(compiled.redeemScriptHex).not.toContain(bytesToHex(pushBytes(encodeScriptNum(expirationTimeMs))));
  });

  it('rewrites finalize as a preimage-based branch without BCH native introspection opcodes', () => {
    const goal = 125_001n;
    const feeCapSats = 1_000n;
    const compiled = compileCampaignCovenantV1({
      goal,
      expirationTime: 1_735_689_601n,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
      feeCapSats,
    });
    const finalizeBranchHex = compiled.redeemScriptHex.slice(
      bytesToHex([OP.OP_DUP, OP.OP_1, OP.OP_NUMEQUAL, OP.OP_IF]).length,
      compiled.redeemScriptHex.indexOf(bytesToHex([OP.OP_ELSE, OP.OP_DUP, OP.OP_2, OP.OP_NUMEQUAL, OP.OP_IF])),
    );

    expect(finalizeBranchHex).toContain(bytesToHex([OP.OP_SHA256, OP.OP_DUP, OP.OP_FROMALTSTACK]));
    expect(finalizeBranchHex).toContain(bytesToHex([OP.OP_CHECKDATASIGVERIFY]));
    expect(finalizeBranchHex).toContain(bytesToHex([OP.OP_HASH256, OP.OP_ROT, OP.OP_EQUALVERIFY]));
    expect(finalizeBranchHex).toContain(bytesToHex([OP.OP_SPLIT]));
    expect(finalizeBranchHex).toContain(bytesToHex([OP.OP_NIP]));
    expect(finalizeBranchHex).toContain(bytesToHex([OP.OP_BIN2NUM]));
    expect(finalizeBranchHex).toContain(bytesToHex(pushBytes(Uint8Array.from([0xc3, 0x00, 0x00, 0x00]))));
    expect(finalizeBranchHex).toContain(bytesToHex([...pushScriptNum(8n), OP.OP_SPLIT, OP.OP_DROP]));
    expect(finalizeBranchHex).not.toContain(bytesToHex([OP.OP_SPLIT, OP.OP_EQUALVERIFY]));
    expect(finalizeBranchHex).toContain(bytesToHex(pushBytes(encodeScriptNum(goal))));
    expect(finalizeBranchHex).toContain(bytesToHex(pushBytes(encodeScriptNum(feeCapSats))));
    expect(finalizeBranchHex).not.toContain(bytesToHex([OP.OP_INPUTINDEX, OP.OP_UTXOVALUE]));
    expect(finalizeBranchHex).not.toContain(bytesToHex([OP.OP_OUTPUTVALUE, OP.OP_OUTPUTBYTECODE]));
  });

  it('uses a minimal refund branch with CLTV and oracle checks only', () => {
    const expirationTime = 1_735_689_601n;
    const compiled = compileCampaignCovenantV1({
      goal: 125_001n,
      expirationTime,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
    });
    const refundBranchHex = compiled.redeemScriptHex.slice(
      compiled.redeemScriptHex.indexOf(bytesToHex([OP.OP_ELSE, OP.OP_DUP, OP.OP_2, OP.OP_NUMEQUAL, OP.OP_IF]))
        + bytesToHex([OP.OP_ELSE, OP.OP_DUP, OP.OP_2, OP.OP_NUMEQUAL, OP.OP_IF]).length,
      compiled.redeemScriptHex.indexOf(bytesToHex([OP.OP_ELSE, OP.OP_3, OP.OP_NUMEQUALVERIFY])),
    );

    expect(refundBranchHex).toContain(bytesToHex([OP.OP_DROP]));
    expect(refundBranchHex).toContain(bytesToHex(pushBytes(encodeScriptNum(expirationTime))));
    expect(refundBranchHex).toContain(bytesToHex([OP.OP_CHECKLOCKTIMEVERIFY, OP.OP_DROP]));
    expect(refundBranchHex).toContain(bytesToHex(pushBytes(Buffer.from(REFUND_ORACLE_PUBKEY, 'hex'))));
    expect(refundBranchHex).toContain(bytesToHex([OP.OP_CHECKSIGVERIFY, OP.OP_1]));
    expect(refundBranchHex).not.toContain(bytesToHex([OP.OP_TXOUTPUTCOUNT]));
    expect(refundBranchHex).not.toContain(bytesToHex([OP.OP_OUTPUTBYTECODE]));
    expect(refundBranchHex).not.toContain(bytesToHex([OP.OP_INPUTINDEX, OP.OP_UTXOBYTECODE]));
  });
});

describe('compileCampaignScript', () => {
  it('selects Teyolia Covenant V1 when beneficiary and oracle pubkeys are available', () => {
    const compiled = compileCampaignScript({
      id: 'campaign-script-v1',
      name: 'Teyolia',
      description: '',
      goal: 42_000n,
      expirationTime: 950_000n,
      beneficiaryPubKey: BENEFICIARY_PUBKEY,
      refundOraclePubKey: REFUND_ORACLE_PUBKEY,
      contractVersion: TEYOLIA_COVENANT_V1,
    });

    expect(compiled.contractVersion).toBe(TEYOLIA_COVENANT_V1);
    expect(compiled.redeemScriptHex).toMatch(/^[0-9a-f]+$/);
    expect(compiled.scriptHex).toBe(compiled.scriptPubKeyHex);
    expect(compiled.scriptHash).toBe(compiled.scriptHashHex);
  });
});
