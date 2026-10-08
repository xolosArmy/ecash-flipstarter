// Inventario del commit exacto (TA1-M1): archivado, reproducible y completo frente a la
// referencia independiente del Auditor (P-4 I-3: 42 nombres).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { FIXTURES } from './helpers.mjs';
import { BASE_COMMIT, INVENTORY_FILE, INVENTORY_SHA_FILE, generateInventory, parseInventory } from '../scripts/inventory.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const archived = readFileSync(INVENTORY_FILE, 'utf8');
const inv = parseInventory(archived);

describe('inventario archivado de 239f9dc', () => {
  test('commit base y .sha256', () => {
    assert.equal(inv.commit, BASE_COMMIT);
    assert.equal(BASE_COMMIT, '239f9dc9d64361700b798cebde0f30a0dc368e7b');
    assert.equal(readFileSync(INVENTORY_SHA_FILE, 'utf8'), `${sha(archived)}  239f9dc.inventory.txt\n`);
  });
  test('se regenera idéntico desde backend/src', async () => {
    assert.equal(await generateInventory(), archived);
  });
  test('contiene los 42 nombres de la referencia del Auditor (I-3, sha256 13a61a9e…def9e)', () => {
    const refRaw = readFileSync(path.join(FIXTURES, 'auditor-i3-reference-239f9dc.txt'));
    assert.equal(sha(refRaw), '13a61a9eca9242a2590bfcd524abc2ab77702e9ad5db91eb2cc1d25b359def9e');
    const ref = refRaw.toString('utf8').split('\n').filter(Boolean);
    assert.equal(ref.length, 42);
    for (const n of ref) assert.ok(inv.envNames.has(n), `falta ${n}`);
    assert.equal(inv.envNames.size, 42);
  });
  test('variables I-3 del apéndice delta exigidas por el plan §4.2.8', () => {
    for (const n of ['BENEFICIARY_PUBKEY', 'TEYOLIA_BENEFICIARY_PUBKEY', 'REFUND_ORACLE_PUBKEY', 'GAS_WALLET_ADDRESS', 'TEYOLIA_GAS_WALLET_ADDRESS', 'TEYOLIA_TREASURY_ADDRESS', 'TEYOLIA_ACTIVATION_FEE_XEC', 'ECASH_NETWORK', 'E_CASH_BACKEND']) {
      assert.ok(inv.envNames.has(n), n);
    }
  });
  test('loadDotEnv de server.ts marcado como CANAL; nombres vía resolvePrivateKeyFromEnv', () => {
    assert.match(archived, /^CANAL \| server:44 \| escritura dinámica process\.env\[key\] en loadDotEnv/m);
    assert.match(archived, /^ENV TEYOLIA_REFUND_ORACLE_PRIVKEY \|.*vía resolvePrivateKeyFromEnv/m);
    assert.match(archived, /^NO_LEIDA CORS_ALLOW_DEV_LOCALHOST /m);
  });
  test('marcas de módulos clave', () => {
    const has = (id, mark) => assert.ok(inv.flagged.get(id)?.direct.includes(mark), `${id} ${mark}`);
    has('blockchain/ecashClient', 'TRANSMITE');
    has('blockchain/txBuilder', 'FIRMA');
    has('services/RefundService', 'LEE_LLAVE');
    has('services/CampaignService', 'LEE_LLAVE');
    has('config/env', 'LEE_CREDENCIAL');
    has('config/ecash', 'LEE_CREDENCIAL');
    has('store/db', 'DB_LEGACY');
    has('db/SQLiteStore', 'DB_LEGACY');
    has('server', 'CANAL');
  });
});

describe('el inventario detecta cada patrón (fixture sintético, no vacuo)', () => {
  test('directa, índice literal, desestructurada, por nombre pasado a función, escritura dinámica y marcas', async () => {
    const text = await generateInventory(path.join(FIXTURES, 'inventory-src'));
    const p = parseInventory(text);
    for (const n of ['FIXTURE_RPC_USER', 'FIXTURE_RPC_URL', 'FIXTURE_DESTRUCTURED', 'FIXTURE_SIGNER_PRIVKEY', 'FIXTURE_SIGNER_SEED']) assert.ok(p.envNames.has(n), n);
    assert.match(text, /^ENV FIXTURE_SIGNER_PRIVKEY \|.*vía readNamed/m);
    assert.match(text, /^CANAL \| boot:4 \|/m);
    assert.ok(p.flagged.get('services/sender').direct.includes('TRANSMITE'));
    assert.ok(p.flagged.get('services/keys').direct.includes('FIRMA'));
    assert.ok(p.flagged.get('services/keys').direct.includes('LEE_LLAVE'));
    assert.ok(p.flagged.get('config/net').direct.includes('LEE_CREDENCIAL'));
    assert.ok(p.flagged.get('boot').reached.includes('TRANSMITE'));
  });
});
