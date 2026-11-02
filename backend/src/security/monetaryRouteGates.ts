// P7A-07: gates fail-closed de las rutas públicas que transmiten (broadcast) o que firman con llaves
// del entorno y transmiten (finalize / finalize-request / payout/build).
//
// - Apagados por defecto: solo el valor exacto 'true' habilita (sin trim ni mayúsculas; '1', 'yes',
//   'TRUE' o ' true ' quedan APAGADOS). Se leen en cada petición, no al cargar el módulo.
// - Cada gate es la PRIMERA sentencia de su handler: con el flag apagado no se lee el body, la campaña,
//   FORCE_RESCUE_CAMPAIGN_ID ni ninguna llave, y no se llama a ningún servicio.
// - Familias independientes: un flag no habilita la otra familia ni los refunds (ENABLE_PUBLIC_REFUNDS
//   vive en routes/refund.routes.ts y no se toca aquí).

export const MONETARY_ROUTE_DISABLED_STATUS = 403;

export const PUBLIC_BROADCAST_DISABLED_CODE = 'public-broadcast-disabled';
export const CAMPAIGN_FINALIZE_DISABLED_CODE = 'campaign-finalize-disabled';

export function isPublicBroadcastEnabled(): boolean {
  return process.env.ENABLE_PUBLIC_BROADCAST === 'true';
}

export function isCampaignFinalizeEnabled(): boolean {
  return process.env.ENABLE_CAMPAIGN_FINALIZE === 'true';
}

export function publicBroadcastDisabledBody(): { error: string; code: string } {
  return { error: PUBLIC_BROADCAST_DISABLED_CODE, code: PUBLIC_BROADCAST_DISABLED_CODE };
}

export function campaignFinalizeDisabledBody(): { error: string; code: string } {
  return { error: CAMPAIGN_FINALIZE_DISABLED_CODE, code: CAMPAIGN_FINALIZE_DISABLED_CODE };
}
