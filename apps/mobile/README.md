# Pegasus for iPhone

Follow and steer your Pegasus chats from your phone. The app pairs with your PC from the QR code in
Pegasus › Settings › Phone and talks to the Pegasus host on the PC over Tailscale.

Built the way T3 Code builds theirs: Expo 58, React Native 0.88.1, native stack, Reanimated, Legend
List, with T3's enriched-markdown and react-native-screens forks vendored in `deps/` (MIT, see
`LICENSE-T3`). Every color comes from `src/theme.ts`.

## Build (on the Mac)

The app is not part of the desktop pnpm workspace; it installs on its own:

```sh
pnpm install --ignore-workspace        # hoisted node_modules (.npmrc), as Metro needs
npx tsc --noEmit                       # typecheck
node --test --experimental-strip-types src/api/logic.test.ts
npx expo prebuild --clean --platform ios   # needs CocoaPods (brew install cocoapods)
```

Simulator (Release embeds the JS bundle, so no dev server is needed). Sign to run locally: an
unsigned build cannot use the Keychain.

```sh
cd ios && xcodebuild -workspace Pegasus.xcworkspace -scheme Pegasus -configuration Release \
  -sdk iphonesimulator -destination "generic/platform=iOS Simulator" -derivedDataPath build \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_ALLOWED=YES
```

Your iPhone: `pnpm ios:device` with the phone connected and your Apple Development team selected.

## Updates over the air (from the PC)

JS changes reach the phone without the Mac: the Pegasus host on the PC serves
`GET /v1/updates/manifest` and `/v1/updates/assets/<sha256>.<ext>` (expo-updates protocol v1, no
token, only on 127.0.0.1 and the Tailscale IP) from `D:\Pi\pi-ecosystem\.state\mobile-updates`.

```powershell
node apps/mobile/scripts/publish-update.mjs [--json]              # export, sign, switch latest, keep 5
node apps/mobile/scripts/publish-update.mjs --rollback <id> [--json]  # republish an older update's code
```

- Signing: the app embeds `updates/certificate.pem` and accepts only manifests signed by
  `.state\mobile-updates\keys\private-key.pem` (never in the repo). A new key pair means a new
  native install.
- `runtimeVersion` uses the fingerprint policy, so an update only reaches builds with identical
  native code. A native change (new module, version bump, config) needs one install from the Mac;
  until then the PC answers that build with "no update".
- The app checks on launch and on returning to the foreground; a downloaded update starts on the next
  launch, or at once from the "Update ready" prompt.

## How it connects

- Pairing: QR code or `pegasus://pair?v=1&url=http://<PC tailscale ip>:47219&token=…&name=…`
  (the Camera app opens these links). The key is kept in the Keychain, this device only.
- API: `POST /v1/invoke` and `GET /v1/events` (server-sent events), the same remote desktop API the
  Mac client uses, served by the Rust host on the PC.
- Wire types: `src/api/types.ts`; `apps/desktop/electron/remote/mobile-wire-types.check.ts` fails the
  desktop typecheck if the desktop's types stop fitting them.
- End to end: `apps/desktop/tests/production/phone-remote.spec.ts` (set `PEGASUS_PHONE_E2E_MAC`).
