# VoiceUPI MVP

A phone-only, local-first proof of concept for voice-originated UPI payment intent.

## What it does
- Voice command -> structured payment intent using a deterministic local parser (no paid AI API).
- Example: “Scan this for groceries” -> opens QR scanner.
- Scans a merchant UPI QR using the phone camera.
- Shows merchant/VPA/purpose and amount confirmation.
- Launches the device's UPI payment handler with a `upi://pay` URI.
- Never asks for, reads, or stores a UPI PIN.
- Stores transaction metadata locally on the phone.
- Attempts to process a returned UPI callback when the payment app supplies one; otherwise the transaction remains initiated/pending until you add a provider-specific verified status flow.
- Works from one React Native/Expo codebase for Android and iOS.

## Important MVP limitation
A third-party app cannot reliably force PhonePe or Google Pay to open their internal QR scanner using a public cross-platform API. This MVP therefore scans the merchant QR itself, constructs a UPI payment URI, and hands the payment off to an installed UPI app. That is the standards-aligned prototype path.

Likewise, a universal always-listening wake phrase such as “Hey VoiceUPI” is not something this MVP assumes. iOS and Android impose background microphone/assistant restrictions. The MVP uses a foreground voice button; later, native assistant/shortcut integrations can be evaluated.

## Free stack
- React Native + Expo
- TypeScript
- expo-camera
- expo-linking
- expo-speech-recognition
- expo-speech
- AsyncStorage
- No backend
- No paid LLM
- No analytics SDK

Expo itself is open source/free. Device builds may still require platform accounts/signing for distribution; Apple App Store distribution requires Apple’s developer program.

## Setup

1. Install Node.js LTS.
2. Install dependencies:

```bash
npm install
```

3. Generate native projects:

```bash
npx expo prebuild --clean
```

4. Android:

```bash
npx expo run:android
```

5. iOS (requires macOS + Xcode):

```bash
npx expo run:ios
```

Because voice recognition uses a native module, do not rely on Expo Go for the complete MVP. Use a development build/native run.

## Test

Use a real Android/iPhone for camera and microphone tests.

Example voice commands:
- “Scan this for groceries”
- “Pay 500 for lunch”
- “Pay 250 to Rahul for electricity”
- “Record 300 spent on taxi”

For a safe first test, use a test/low-value UPI payment. Never enter your UPI PIN into VoiceUPI.

## Next engineering stages
1. Replace the local intent parser with a constrained on-device/approved AI intent model if needed.
2. Add Hindi/Hinglish and regional-language intent parsing.
3. Add provider-specific UPI callback/status verification.
4. Add encrypted local storage and biometric app lock.
5. Add proper transaction reconciliation.
6. Prototype Android assistant/shortcut entry points.
7. Build a partner demo for PhonePe/NPCI using simulated payments first.
8. Only after product validation investigate sponsor-bank/TPAP/UPI ecosystem onboarding.
