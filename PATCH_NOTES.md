# Teyolia Flipstarter payout patch

## Bugs corregidos

- Se corrigio la conversion de unidades en backend para tratar eCash como `1 XEC = 100 sats`.
- Se elimino la logica heredada de `1e8` en lecturas RPC y se centralizo la conversion en `backend/src/utils/ecashUnits.ts`.
- El builder de payout ya no intenta partir la transaccion entre beneficiario y treasury. Por ahora genera una sola salida principal al beneficiario.
- El frontend ya no pide a la wallet del usuario firmar un payout del escrow/covenant. Ahora llama al backend mediante `POST /api/campaigns/:id/finalize-request`.

## Por que 1 XEC = 100 sats

- En eCash, la unidad base usada por la app es `sats` o `bits`, donde `1 XEC = 100 sats`.
- El bug venia de multiplicar importes decimales por `1e8`, lo que inflaba balances y comparaciones de meta.

## Treasury fee temporalmente deshabilitada

- El covenant actual de finalize, segun la logica existente en `contracts/src/covenant_campaign.ts`, espera una salida simple al beneficiario y que el covenant termine.
- Mientras el covenant no sea redisenado para soportar explicitamente una salida adicional a treasury, la comision de treasury queda en `0` dentro del payout.

## Cambio de flujo de payout

- El payout ya no pertenece a la wallet del usuario porque los fondos salen de la direccion de campana/covenant, no de la wallet conectada del frontend.
- El endpoint backend toma siempre el `beneficiaryAddress` desde la base de datos/campana, no desde input del cliente.
- El endpoint agrega idempotencia basica: si ya existe `payout.txid` o el estado es `paid_out`, no reintenta.

## Limitacion actual del covenant

- El repositorio actual si puede construir el esqueleto del payout, pero no implementa todavia el unlocking script real del spend path de finalize.
- `backend/src/blockchain/txBuilder.ts` sigue serializando inputs sin `scriptSig`, asi que el backend no puede transmitir un payout valido del covenant automaticamente todavia.
- Por eso `AutoPayoutService` deja el flujo preparado y responde `auto-payout-spend-path-missing` hasta que exista una implementacion real del finalize spend path backend-side.

## Alcance

- No se toco el flujo WalletConnect de pledges ni el pago de activacion.
- No se afirma equivalencia trustless con Flipstarter clasico. El covenant actual sigue comportandose como un escrow/P2SH de logica minima comparado con un assurance contract clasico.
