// Fixture sintético del inventario (no es código real).
export function readNamed(names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}
export function signFixture(): void {}
export const k = readNamed(['FIXTURE_SIGNER_PRIVKEY', 'FIXTURE_SIGNER_SEED']);
