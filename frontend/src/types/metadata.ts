/** Explicit, inert campaign API contract. None of these fields authorizes a transaction. */
export interface CampaignMode {
  apiVersion?: string;
  recordKind?: string;
  monetaryEnabled?: boolean;
  capabilities?: { monetary?: boolean };
  expirationTime?: string;
  planning?: CampaignPlanning;
}

export interface CampaignPlanning {
  thesis?: unknown;
  milestones?: unknown;
  agentic?: unknown;
  administration?: unknown;
  evidence?: unknown;
  proposedPnL?: unknown;
}

export interface MetadataLocation {
  latitude: number;
  longitude: number;
}

export interface MetadataCampaign extends CampaignMode {
  apiVersion: 'teyolia.metadata.v1';
  recordKind: 'metadata-only';
  monetaryEnabled: false;
  capabilities: { monetary: false };
  id: string;
  name: string;
  description: string;
  goal: string;
  expirationTime: string;
  expiresAt: string;
  createdAt: string;
  status: 'draft';
  planning: CampaignPlanning;
  location?: MetadataLocation;
}
