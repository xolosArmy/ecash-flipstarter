import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ToastProvider';
import { DERIVED_COLLECTION_ADDRESS_NOTICE, ecashAddressFromPublicKey } from '../wallet/ecashPublicKey';
import { CreateCampaignWizard } from './CreateCampaignWizard';
import { Home } from './Home';

const PUBKEY_B = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const ADDRESS_A = 'ecash:qzklee2022djz48rcdsmhclh6swmqc6hzuqf9vutqh';
const ADDRESS_B = ecashAddressFromPublicKey(PUBKEY_B);

const api = vi.hoisted(() => ({
  createCampaign: vi.fn(),
  fetchCampaigns: vi.fn(() => Promise.resolve([])),
  fetchCampaignSummary: vi.fn(() => Promise.resolve({
    id: 'camp-1',
    status: 'draft',
    apiVersion: 'teyolia.legacy.v1',
    name: 'Campaña norte',
    goal: '1000',
    expiresAt: '2100-01-01T00:00:00.000Z',
  })),
  fetchGlobalStats: vi.fn(() => Promise.resolve(null)),
  fetchCampaignActivationStatus: vi.fn(),
  buildCampaignActivationTx: vi.fn(),
  confirmCampaignActivationTx: vi.fn(),
}));
const wallet = vi.hoisted(() => ({
  publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  addresses: ['ecash:qzklee2022djz48rcdsmhclh6swmqc6hzuqf9vutqh'],
  connected: true,
  topic: 'topic',
  signClient: null,
  uri: null,
  status: 'connected' as const,
  error: null,
  projectIdMissing: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
  resetSession: vi.fn(),
  requestAddresses: vi.fn(),
  requestAccountPublicKey: vi.fn(),
  requestSignAndBroadcast: vi.fn(),
}));

vi.mock('../wallet/useWalletConnect', () => ({
  useWalletConnect: () => wallet,
}));

vi.mock('../context/CampaignCapabilities', () => ({
  useCampaignCapabilities: () => ({
    monetaryEnabled: true,
    ready: true,
    error: null,
    capabilities: {
      apiVersion: 'teyolia.legacy.v1',
      monetaryEnabled: true,
      capabilities: { monetary: true },
    },
  }),
}));

vi.mock('../api/client', () => api);

let container: HTMLDivElement;
let root: Root;

function setControl(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  api.createCampaign.mockReset();
  api.createCampaign.mockResolvedValue({ id: 'camp-1', status: 'draft', apiVersion: 'teyolia.legacy.v1' });
  wallet.publicKey = PUBKEY_B;
  wallet.addresses = [ADDRESS_A];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('derived recipient address parity', () => {
  it('locks Home to the address of the signed public key and submits that pair', async () => {
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(Home)));
    });

    const openForm = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Mostrar creación manual');
    await act(async () => {
      openForm!.click();
    });

    const addressInput = container.querySelector<HTMLInputElement>('input[placeholder="recipientAddress (ecash:...)"]')!;
    expect(addressInput.value).toBe(ADDRESS_B);
    expect(addressInput.readOnly).toBe(true);
    expect(container.textContent).toContain(DERIVED_COLLECTION_ADDRESS_NOTICE);
    expect(container.textContent).toContain('Conectado: ecash:qzkl...9vutqh');
    expect(addressInput.value).not.toBe(ADDRESS_A);

    await act(async () => {
      setControl(addressInput, ADDRESS_A);
    });
    expect(addressInput.value).toBe(ADDRESS_B);

    const form = addressInput.closest('form')!;
    setControl(form.querySelector<HTMLInputElement>('input[placeholder="Nombre de campaña"]')!, 'Campaña norte');
    setControl(form.querySelector<HTMLTextAreaElement>('textarea')!, 'Descripción de la recaudación');
    setControl(form.querySelector<HTMLInputElement>('input[placeholder="Meta (XEC)"]')!, '10');
    setControl(form.querySelector<HTMLInputElement>('input[type="datetime-local"]')!, '2100-01-01T12:00');

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(api.createCampaign).toHaveBeenCalledWith(expect.objectContaining({
      recipientAddress: ADDRESS_B,
      beneficiaryAddress: ADDRESS_B,
      beneficiaryPubkey: PUBKEY_B,
      beneficiaryPubKey: PUBKEY_B,
    }));
  });

  it('locks the wizard to the address of the signed public key and submits that pair', async () => {
    await act(async () => {
      root.render(React.createElement(
        MemoryRouter,
        null,
        React.createElement(ToastProvider, null, React.createElement(CreateCampaignWizard)),
      ));
    });

    const addressInput = container.querySelector<HTMLInputElement>('input[placeholder="ecash:..."]')!;
    expect(addressInput.value).toBe(ADDRESS_B);
    expect(addressInput.readOnly).toBe(true);
    expect(container.textContent).toContain(DERIVED_COLLECTION_ADDRESS_NOTICE);

    await act(async () => {
      setControl(addressInput, ADDRESS_A);
    });
    expect(addressInput.value).toBe(ADDRESS_B);

    const form = addressInput.closest('form')!;
    const [nameInput, goalInput, expiresInput] = form.querySelectorAll('input');
    setControl(nameInput, 'Campaña norte');
    setControl(goalInput, '10');
    setControl(expiresInput, '2100-01-01');

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(api.createCampaign).toHaveBeenCalledWith(expect.objectContaining({
      recipientAddress: ADDRESS_B,
      beneficiaryAddress: ADDRESS_B,
      beneficiaryPubkey: PUBKEY_B,
      beneficiaryPubKey: PUBKEY_B,
    }));
  });
});
