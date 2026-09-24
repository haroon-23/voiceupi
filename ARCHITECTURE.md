# VoiceUPI — Architecture

Status: MVP prototype. Voice migrated to `expo-speech-recognition` (SDK 57).
Voice has NOT been validated in a native build yet — do not claim it works until
`npx expo run:android` / `npx expo run:ios` + on-device mic test passes.

## 1. Application layers

- `App.tsx` — single-root UI state machine, no router. Screens:
  `home | scan | confirm | history` via `useState`. Owns intent, QR, amount,
  transactions, and UPI-callback (`txId`) state.
- `src/components/VoiceButton.tsx` — foreground voice capture button.
  Wraps `expo-speech-recognition` (`requestPermissionsAsync` + `start` +
  `useSpeechRecognitionEvent` for `start/end/result/nomatch/error`). Forwards only
  trimmed final transcripts to `onResult`. No intent logic here.
- `src/lib/intent.ts` — deterministic local intent parser (`parseIntent`).
- `src/lib/upi.ts` — UPI URI boundary (`parseUpiUri`, `buildUpiPayUrl`, `openUpi`).
- `src/lib/storage.ts` — local persistence over AsyncStorage.
- `src/lib/types.ts` — `PaymentIntent`, `Transaction` strict types.
- Platform config: `app.json` (name/scheme/permissions/plugins),
  `babel.config.js` (`babel-preset-expo`), `tsconfig.json` (strict, extends
  `expo/tsconfig.base`). No `metro.config.js`, no `app.config.*`, no ESLint config.

## 2. Voice intent engine

- Input: final transcript from `VoiceButton` (`lang: 'en-IN'`, `interimResults: true`,
  `continuous: false`, `maxAlternatives: 1`), or typed text on web-unsupported browsers.
- `parseIntent(rawText)` actions: `SCAN_AND_PAY` | `RECORD_EXPENSE` |
  `SHOW_HISTORY` | `CANCEL` | `GO_BACK` | `START_OVER` | `REPEAT` | `HELP` |
  `UNKNOWN`. Meta commands are matched first (word-boundaried) so "stop"/"back"
  never become payments.
- Payment fields: currency-marked amount wins, else a single bare number;
  `recipientVpa` extracted and strictly validated (shared `isValidVpa` in
  `types.ts`); explicit-QR requests flagged; `missing: ('amount'|'recipient')[]`
  + `clarification` question instead of invented facts. A bare name
  ("Pay Rahul 500") is never resolved to a VPA.
- `App` draft flow: complete VPA+amount → confirm directly; explicit QR or
  amount-less → scanner; otherwise an inline home card asks for the missing
  slot (voice or typed follow-up fills it; "scan" detours to the scanner;
  cancel/start-over reset). Identical repeat deliveries deduped (5s).
- Confirm-state voice: "yes/continue" confirms only on the confirm screen;
  "no/cancel" aborts; "repeat" re-reads; TTS read-aloud fires once per
  confirmation with a header Mute/Unmute toggle (never on re-render).

## 3. Payment orchestration boundary

- `openUpi(url)` = `expo-linking.openURL('upi://pay?...')`. App hands off to the OS;
  the installed UPI app owns auth + PIN + settlement.
- `App.startPayment`: requires a strictly valid amount (₹1–₹1,00,000 via
  `parseAmountInput`), saves `Transaction(kind: 'upi_handoff', status: 'initiated')`
  (aborts before opening the UPI app if the save fails), stores
  `callbackTx = txId`, then `openUpi`. If open fails → `status: 'pending'` +
  "install a UPI app" alert.
- Callback: `Linking.addEventListener('url')` parses `voiceupi://...?txId=&Status=`
  with exact-token matching (`success` → `success`; `failure|failed|fail` →
  `failed`; anything else leaves the row untouched — never substring matching).
  This is opportunistic, not bank-grade: most UPI apps never call back, so
  `initiated/pending` is the normal resting state and `success` means only
  "exact-token callback received" (shown in the UI as `callback-confirmed`,
  never as bank proof). There is deliberately NO fake success marking,
  and repeated confirmation taps / duplicate note deliveries are guarded
  (`paying` lock, 5s identical-note dedupe).
- PIN rule: VoiceUPI never requests, receives, or stores any UPI PIN
  (confirm screen states this explicitly).

## 4. QR scanning

- Native: `expo-camera` `CameraView` with `barcodeTypes: ['qr']`, `onBarcodeScanned → onScanned`.
- Web (`src/components/WebQrScanner.tsx`, rendered only when `Platform.OS === 'web'`):
  `getUserMedia` (rear camera) + canvas frame capture + `jsqr` decoding at ~2fps.
  Decoded strings flow through the same `onScanned` → `parseUpiUri` →
  `enterConfirm` path, so validation, single-handle-per-session, and error
  rate-limiting are identical. Camera denial/unavailability shows a fallback
  screen with manual UPI-ID entry. Tracks are stopped on unmount.
- Manual UPI-ID entry (all platforms): `isValidVpa`-gated form building a
  `ParsedUpi` without `am`, payable with a manual amount at confirm.
- `onScanned` accepts only validated `upi://pay` URIs VPA must match
  `name@bank` shape, currency must be INR, `am` when present must be a positive
  finite number (invalid `am` is dropped so the merchant stays payable with a
  manual amount). Rejections are never silent: `describeUpiQrProblem` yields a
  specific overlay message (not-UPI / unsupported type / missing payee /
  invalid payee / non-INR), rate-limited to one per 3s, and repeat frames of one
  valid QR are handled once per scan session. `getUserMedia` has a 15s hang
  guard with Try-again recovery; late-resolving streams are released; tracks
  always stop on unmount.
- Permissions: `expo-camera` config-plugin `cameraPermission`; runtime via
  `useCameraPermissions()`. Scan screen is full-bleed black with centered
  270px target box — one-handed, portrait-only (`orientation: portrait`).

## 5. Transaction storage

- `AsyncStorage` key `@voiceupi/transactions/v1`, newest-first, capped at 500.
- `Transaction { id, kind: manual_note|upi_handoff,
  status: initiated|pending|success|failed|recorded, amount, merchantName,
  merchantVpa, category, purpose, rawCommand, createdAt, upiUrl }`.
- `RECORD_EXPENSE` rows are stored as `kind: 'manual_note'`, `status: 'recorded'`
  (local log, not a bank payment) — never counted in any verified-payment total.
  History shows separate manual-note and handoff totals with initiated/pending/
  failed/callback-confirmed counts; rows carry kind + status labels, invalid dates render as
  "Unknown date," long text is clamped, and empty history has a guidance message.
- No backend, no encryption, no biometric lock (future work).

## 6. Security considerations

- Never collect/store/process UPI PIN. No bank credentials. No WebView payment.
- `upi://pay` URL carries only `pa/pn/am/cu/tn/tr`; amount formatted to 2dp,
  `tn` truncated to 80 chars.
- `LSApplicationQueriesSchemes: [upi, phonepe, tez, gpay, paytmmp, bhim]` is
  query-only (iOS); no internals access claimed.
- Local storage is plaintext; threat model = device owner only for MVP.

## 7. iOS / Android constraints

- Requires dev build / `expo run:*` — native modules (`expo-camera`,
  `expo-speech-recognition`) do not fully work in Expo Go.
- iOS: `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`,
  `NSCameraUsageDescription` in `infoPlist`; speech = `SFSpeechRecognizer`
  (network by default; MDM/Screen-Time restrictions can block it).
- Android: `CAMERA`, `RECORD_AUDIO` permissions; speech = `SpeechRecognizer`
  (Google service dependent; `continuous` + recording need Android 13+;
  on-device models may need download; emulator results vary).
- No background wake word ("Hey VoiceUPI" explicitly out of scope).
- `supportsTablet: false`, `userInterfaceStyle: dark`, scheme `voiceupi://`
  doubles as logical callback scheme.

## 8. Known limitations (do not paper over)

1. Voice unvalidated in a native build (foreground button + `en-IN` only; denial, no-speech, and nomatch now surface inline messages, but native microphone behavior is unproven until device testing).
2. Intent parser is keyword/regex — fragile on phrasing, no multilingual support,
   amount is never invented when utterances are ambiguous.
3. QR scan rejects non-UPI content with an on-screen message (rate-limited); no torch, no manual VPA entry.
4. Payment result is best-effort: without a provider callback the ledger stays
   `initiated/pending`. No reconciliation, no provider status API.
5. Manual notes are `recorded` local-only records, never counted as verified payments.
6. Duplicate `camera` style key in `App.tsx` fixed in Step 1 (removed second
   `camera: { flex: 1 }`, kept `{ flex: 1, backgroundColor: '#000' }`); `tsc --noEmit` passes.
7. `cryptoRandom()` is `Date.now + Math.random` — ids only, not cryptographic.

## 9. Proposed testing strategy (not yet executed)

- `npm run typecheck` (`tsc --noEmit`), `npx expo config --type public` (prebuild
  dry-check), `grep` for `@react-native-voice/voice` (must be zero).
- Automated (`npm test` → `scripts/selftest.js`, zero new deps): compiles
  `src/lib` with the repo TypeScript, stubs native modules, and asserts intent
  actions/VPA/missing-field behavior, amount bounds, QR accept/reject +
  messages, handoff-URL honesty, storage normalization/legacy-migration/delete,
  and unknown-status resting state. 26 assertions, all passing at last run.
- Browser automation: none available. Camera/mic/UPI on iPhone: NOT TESTED.
- Device (deferred per instructions, no physical test in Step 1):
  dev-build install → mic permission → en-IN utterances → QR fixtures
  (with/without `am`) → low-value handoff → callback vs. no-callback ledger check.
- Regression: confirm no `any` in new voice code, no placeholder success logic,
  no new paid deps.

## 10. Physical-device test checklist (all NOT TESTED)

No physical-device testing has been performed. Every item below is NOT TESTED
until executed on a real device and recorded with build id + date.

VOICE (dev build, real device):
- Permission granted → NOT TESTED
- Permission denied → NOT TESTED
- Empty speech / silence → NOT TESTED
- Valid voice command → NOT TESTED
- Invalid voice command → NOT TESTED
- Repeated start taps → NOT TESTED

CAMERA (dev build, real device):
- Camera permission granted → NOT TESTED
- Camera permission denied → NOT TESTED
- Valid UPI QR → NOT TESTED
- Invalid QR → NOT TESTED
- Unsupported QR content → NOT TESTED
- Repeated QR detection (same code held up) → NOT TESTED

CONFIRMATION:
- Valid amount → NOT TESTED
- Missing amount → NOT TESTED
- Invalid amount (zero / negative / over-limit) → NOT TESTED
- Purpose editing → NOT TESTED
- Category editing → NOT TESTED
- Repeated confirmation taps → NOT TESTED

UPI (requires an installed UPI app; use a ₹1 test payment):
- UPI app available → NOT TESTED
- No compatible UPI app → NOT TESTED
- External app launch → NOT TESTED
- External app cancellation → NOT TESTED
- Failed handoff → NOT TESTED
- App resumed after handoff (ledger state) → NOT TESTED

HISTORY:
- Manual note recorded and labeled → NOT TESTED
- Initiated handoff listed → NOT TESTED
- Pending handoff listed → NOT TESTED
- Failed handoff listed → NOT TESTED
- Legacy (pre-`kind`) record migration → NOT TESTED
- Empty history message → NOT TESTED
