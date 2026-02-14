import { randomBytes, randomUUID } from 'crypto';

export type WalletConnectOffer = {
  offerId: string;
  campaignId: string;
  unsignedTxHex?: string;
  mode?: 'tx' | 'intent';
  outputs?: Array<{ address: string; valueSats: number }>;
  userPrompt?: string;
  amount: string;
  contributorAddress: string;
  createdAt: number;
  expiresAt: number;
};

const DEFAULT_TTL_MS = Number(process.env.WC_OFFER_TTL_MS) || 10 * 60 * 1000;
const DEFAULT_CLEANUP_MS = Number(process.env.WC_OFFER_CLEANUP_MS) || 60 * 1000;

export class WalletConnectOfferStore {
  private offers = new Map<string, WalletConnectOffer>();
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS, cleanupMs = DEFAULT_CLEANUP_MS) {
    this.ttlMs = ttlMs;
    const interval = setInterval(() => this.cleanup(), cleanupMs);
    if (typeof interval.unref === 'function') interval.unref();
  }

  create(data: Omit<WalletConnectOffer, 'offerId' | 'createdAt' | 'expiresAt'>): WalletConnectOffer {
    return this.createOffer(data);
  }

  createOffer(
    data: Omit<WalletConnectOffer, 'offerId' | 'createdAt' | 'expiresAt'>
  ): WalletConnectOffer {
    const offerId = this.createOfferId();
    const createdAt = Date.now();
    const expiresAt = createdAt + this.ttlMs;
    const offer: WalletConnectOffer = {
      offerId,
      ...data,
      createdAt,
      expiresAt,
    };
    this.offers.set(offerId, offer);
    return offer;
  }

  get(offerId: string): WalletConnectOffer | null {
    const offer = this.offers.get(offerId);
    if (!offer) return null;
    if (Date.now() > offer.expiresAt) {
      this.offers.delete(offerId);
      return null;
    }
    return offer;
  }

  cleanup() {
    const now = Date.now();
    for (const [offerId, offer] of this.offers) {
      if (now > offer.expiresAt) {
        this.offers.delete(offerId);
      }
    }
  }

  private createOfferId(): string {
    if (typeof randomUUID === 'function') return randomUUID();
    return randomBytes(16).toString('hex');
  }
}

export const walletConnectOfferStore = new WalletConnectOfferStore();
