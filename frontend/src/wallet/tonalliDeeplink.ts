import { resolveTonalliBridgeConfig } from './tonalliBridge';

type TonalliExternalSignParams = {
  unsignedTxHex: string;
  returnUrl: string;
  app?: string;
};

function encodeBase64Url(input: string): string {
  const base64 =
    typeof btoa === 'function'
      ? btoa(input)
      : Buffer.from(input, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function buildTonalliExternalSignUrl(params: TonalliExternalSignParams): string {
  const { baseUrl } = resolveTonalliBridgeConfig();
  const payload = {
    unsignedTxHex: params.unsignedTxHex,
    returnUrl: params.returnUrl,
    app: params.app || 'Flipstarter',
  };
  const encoded = encodeBase64Url(JSON.stringify(payload));
  return `${baseUrl}/#/external-sign?request=${encoded}`;
}
