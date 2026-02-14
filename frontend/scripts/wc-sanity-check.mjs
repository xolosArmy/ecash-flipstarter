import fs from 'fs';
import path from 'path';

const configPath = path.resolve(process.cwd(), 'src/walletconnect/config.ts');
const source = fs.readFileSync(configPath, 'utf8');

const hasChain = source.includes("export const CHAIN_ID = 'ecash:1'");
const hasMethod = source.includes("export const REQUIRED_METHOD = 'ecash_signAndBroadcastTransaction'");
const hasNamespace = source.includes('ecash: {');

console.log('[wc-sanity] config file:', configPath);
console.log('[wc-sanity] checks:', { hasNamespace, hasChain, hasMethod });

if (!hasNamespace || !hasChain || !hasMethod) {
  throw new Error('WalletConnect config inválida: falta namespace ecash, chain ecash:1 o method requerido.');
}

console.log('[wc-sanity] OK: namespace ecash + ecash:1 + ecash_signAndBroadcastTransaction');
