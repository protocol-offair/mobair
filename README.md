# MobAir

MobAir is the Android wallet app for the OffAir ecosystem. It keeps the same product architecture that was previously developed under the AirPay name, while moving the public brand away from a conflicting Solana token name.

Portuguese version: [README.pt-BR.md](./README.pt-BR.md)

## What MobAir Does

- Creates and imports self-custody Solana wallets.
- Signs online Solana payments locally.
- Reads Gateway payment links and QR codes.
- Queues deferred-online Gateway payments when the device is temporarily offline.
- Supports OffAir local offline promise flows for nearby peer-to-peer settlement.
- Maintains local risk, trust, score, blocklist cache, and synchronization state.
- Uses Bluetooth, NFC and local background runtime features where available on Android.

## Important Compatibility Notes

The app display name is MobAir. Some technical identifiers intentionally remain unchanged for MVP compatibility:

- Android package id remains `com.airpay.wallet`.
- Payment deep links may still use the legacy `airpay://pay` scheme.
- Protocol payloads may still contain legacy `airpay:*` domains.

These identifiers are protocol compatibility surfaces, not public brand claims.

## Repository Scope

This repository contains only the mobile wallet app. Gateway, website, Support, SDKs, smart contracts, docs and infrastructure live in separate repositories under `protocol-offair`.

## Development

```bash
npm install
npm run typecheck
npm run android
```

Theme-specific local runs:

```bash
npm run android:light
npm run android:dark
```

## Testing

```bash
npm run typecheck
npm run test:offline-sim
npm run smoke:devnet
```

Physical-device offline, hybrid and online testing should use the dedicated ADB scripts from the `offair-infra` repository.

## Boundaries

MobAir is not a bank, exchange, fiat wallet or custodial balance provider. It is a self-custody wallet interface for Solana payments and OffAir risk-bounded offline promise flows.
