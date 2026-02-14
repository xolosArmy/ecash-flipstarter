export const CHAIN_ID = 'ecash:1';
export const REQUIRED_METHOD = 'ecash_signAndBroadcastTransaction';

export const OPTIONAL_NAMESPACES = {
  ecash: {
    chains: [CHAIN_ID],
    methods: [REQUIRED_METHOD],
    events: [],
  },
} as const;
