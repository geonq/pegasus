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

## How it connects

- Pairing: QR code or `pegasus://pair?v=1&url=http://<PC tailscale ip>:47219&token=…&name=…`
  (the Camera app opens these links). The key is kept in the Keychain, this device only.
- API: `POST /v1/invoke` and `GET /v1/events` (server-sent events), the same remote desktop API the
  Mac client uses, served by the Rust host on the PC.
- Wire types: `src/api/types.ts`; `apps/desktop/contracts/mobile-wire-types.check.ts` fails the
  desktop typecheck if the desktop's types stop fitting them.
- End to end: `apps/desktop/tests/production/phone-remote.spec.ts` (set `PEGASUS_PHONE_E2E_MAC`).
