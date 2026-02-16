import fs from 'fs';
import path from 'path';

const clientFile = path.resolve(process.cwd(), 'src/walletconnect/client.ts');
const source = fs.readFileSync(clientFile, 'utf8');

function readConst(name) {
  const match = source.match(new RegExp(`export const ${name} = '([^']+)'`));
  return match ? match[1] : null;
}

const namespace = readConst('WC_NAMESPACE');
const chainId = readConst('CHAIN_ID');
const method = readConst('WC_METHOD');

const requested = {
  requiredNamespaces: {
    [namespace ?? 'unknown']: {
      chains: [chainId],
      methods: [method],
      events: [],
    },
  },
};

console.log('[walletconnect-sanity] requested namespaces:');
console.log(JSON.stringify(requested, null, 2));

const errors = [];
if (namespace !== 'ecash') {
  errors.push(`Expected WC namespace to be "ecash" but got "${namespace}"`);
}
if (chainId !== 'ecash:1') {
  errors.push(`Expected chainId to be "ecash:1" but got "${chainId}"`);
}
if (method !== 'ecash_signAndBroadcastTransaction') {
  errors.push(
    'Expected method to be "ecash_signAndBroadcastTransaction" '
      + `but got "${method}"`
  );
}

if (errors.length > 0) {
  console.error('[walletconnect-sanity] FAILED');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('[walletconnect-sanity] OK');
