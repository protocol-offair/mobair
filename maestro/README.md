# AirPay Maestro Flows

These flows target the Android package `com.airpay.wallet` and rely on stable React Native `testID` selectors.

Available flows:

- `smoke-launch.yaml`
  Verifies the main screen renders and the primary sections are visible after a cold launch.
- `create-wallet-local.yaml`
  Creates a wallet locally, verifies mnemonic reveal, confirms backup, and checks readiness steps.
- `queue-sol-intent.yaml`
  Creates a wallet locally, confirms backup, switches to `SOL`, and queues one signed chain intent.

Usage examples:

```bash
maestro test apps/mobile/maestro/smoke-launch.yaml
maestro test apps/mobile/maestro/create-wallet-local.yaml
maestro test apps/mobile/maestro/queue-sol-intent.yaml
```

Notes:

- The flows are designed to work even when the backend is unavailable.
- `create-wallet-local.yaml` and `queue-sol-intent.yaml` both launch with `clearState: true`.
- If you run against Expo Go instead of the native app package, convert the launch step to `openLink` and keep the same selector ids.

