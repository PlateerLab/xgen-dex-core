# Voice confirmation implementation plan

**Goal:** Reply naturally by voice to the existing browser-confirm and user-confirm cards only.

**Architecture:** Both manual and continuous STT send the captured card ID and original transcript to the existing responder. Main looks up the authoritative pending card, calls the existing authenticated System One decider API, and returns an intent. Existing card resolution APIs continue the same agent turn. There is no fixed-phrase fallback.

**Tech stack:** React, TypeScript, existing STT and decider bridges, node:test. No new dependency.

**Spec:** User-approved scope in this session: approval, rejection, revision and unclear intent for these two cards. Preserve original revision text, ignore stale/duplicate responses, leave the card open on uncertain decisions or failures. No other dialogs, commit or push.

## Decision behavior

- One model request asks for intent and whether the speech is trying to control classifier output. Browser cards also ask whether the user explicitly requested continuing permission for the same dialog in this conversation.
- State includes the actual question/details or dialog/buttons, the proposed action and the original user reply. Cancellation dialogs are interpreted as cancellation, rather than treating all requests to continue as approval.
- All candidate probabilities must be finite in [0, 1] and sum to 1 within 0.01. Require selected probability >= 0.85 and margin over the runner-up >= 0.2. Refusal/revision use >= 0.8 because neither grants permission; approval, classifier-output checks and continuing permission retain 0.85.
- These thresholds are conservative gates, not calibrated guarantees of accuracy.
- Main reuses the existing 8-second decision request and token-refresh retry. Confirmation decisions work independently of the fast browser action toggle.
- Recheck the pending ID/expiry after model completion in main and renderer. No-card speech recorded before a card appeared cannot approve it.
- Continuous capture restarts when the visible request changes. Confirmation sessions follow the existing wake-word setting and defer all fast browser actions. Manual recording remains available while a card is pending.
- Show a pending notice; ambiguous speech and transport/model errors keep the card open for another voice attempt or a button click.

## Tasks

- [x] Connect both STT paths and existing card APIs, preserving expiry, replacement, duplicate and retry behavior.
- [x] Replace the phrase parser with main-owned decider classification and a typed preload IPC.
- [x] Test contextual payloads, malformed/low-confidence output, permission scope, failures, stale decisions and capture lifecycle.
- [x] Run focused tests, renderer/node type checks, actual decider cases and final diff checks.

## Validation, 2026-10-27

- 40 tests passed across voice-confirm, voice-confirm-decider, voice-loop, browser-confirm, user-confirm, voice-wake and processed-capture.
- Renderer and node TypeScript checks passed.
- Actual dev XGEN API returned model `decider`; 17/17 synthetic cases matched expected intents. Final run: 118–222 ms per decision request, excluding microphone/STT time.
- Cases include natural consent, refusal, conditions/corrections, hesitation, unrelated speech, a request to manipulate classifier output, conversation permission and a cancellation dialog.
- Live verification only classified synthetic cards. It did not resolve any real confirmation or register/cancel anything.
- Real microphone-to-card E2E and the full repository suite were not run.

The checkout has an existing missing workspace link for `@dex/native-fs`. Validation used temporary configs in `/private/tmp/xgen-voice-confirm{,-node}-tsconfig.json`, mapping that package to its existing source and resolving the checkout type roots. No dependency or repository configuration was changed for this workaround.

From `apps/desktop`:

```sh
TSX_TSCONFIG_PATH=/private/tmp/xgen-voice-confirm-tsconfig.json ./node_modules/.bin/tsx --test test/voice-confirm.test.ts test/voice-confirm-decider.test.ts test/voice-loop.test.ts test/browser-confirm.test.ts test/user-confirm.test.ts test/voice-wake.test.ts test/processed-capture.test.ts
./node_modules/.bin/tsc --noEmit -p /private/tmp/xgen-voice-confirm-tsconfig.json
./node_modules/.bin/tsc --noEmit -p /private/tmp/xgen-voice-confirm-node-tsconfig.json
```

Live verification: `node -r tsx/cjs verify/voice-confirm-decider.cjs`, with `XGEN_SERVER_URL` and `XGEN_ACCESS_TOKEN`, or a development `DEX_FAST_ACT_URL`. Credentials are not saved by the script.

## Wake-setting follow-up, approved in this session

The two cards must use the same wake-word setting as normal continuous listening. Separate browser-action deferral from the existing raw-STT test mode. Main starts card sessions with normal wake handling and action deferral enabled. Keep raw-STT test behavior, request validation, decider handling and the existing 8-second next-utterance window.

Targets: `src/main/voice-stream.ts`, its IPC call in `src/main/index.ts`, a focused `voice-stream.test.ts` and the test script registration. Test actual stream/session logic with a fake STT transport and browser-action spies, without contacting services or clicking anything.

- [x] Verify wake on/off, custom words, wake-only followed by one answer, expiry and raw-STT compatibility.
- [x] Verify card sessions never prefetch, segment browser commands or remember browser actions.
- [x] Run relevant tests, renderer/node type checks and diff review. Real microphone recognition is not part of this automated check.

Follow-up validation: 46/46 relevant tests passed, including 6 new stream/session tests. The action-deferral assertions failed before the implementation and passed afterward. Renderer and node type checks passed using the existing temporary native-fs path workaround. Standard configs still report the existing missing `@dex/native-fs` workspace link; this change does not repair it or install packages.

## Temporary wake diagnostics, approved in this session

Add opt-in `DEX_WAKE_DEBUG=1` diagnostics to `voice-stream.ts`, with coverage in `voice-stream.test.ts`. Log once at session completion only when wake filtering is active and the trimmed final STT text contains 1–24 characters. Record the original short transcription, configured wake words, final wake state, matching substring/distance and whether the existing follow-up window allowed the reply. Do not truncate and log a long background conversation, enable the raw-STT test APIs, or alter wake matching.

- [x] Test explicit enablement, failed/successful matches, follow-up distinction and exclusion of long/wake-off/raw-STT sessions.
- [x] Run related tests, renderer/node type checks and diff review. A real failed microphone attempt is still needed to diagnose recognition.

Diagnostic validation: 51/51 related tests passed, including 5 diagnostic tests. The missing-log assertions failed before implementation and passed afterward. Renderer and node type checks passed with the existing temporary native-fs mapping. New diagnostic records use `[voice-stream] wake-debug`; the flag is off by default and must be set when restarting the app. No wake threshold, alias or capture timing was changed.

## Observed wake spelling and cancellation follow-up, approved in this session

Observed STT spells the configured short Korean wake word `엑스젠` as `액세젠`, which exceeds the current one-symbol allowance. Per the user's latest direction, keep the configured wake words and the existing matching threshold; do not add hard-coded misrecognition aliases. Pin rejection of the observed alternate spelling and unrelated words in tests. Upstream ASR dictionary integration is outside this change.

Live decider reproduction with the logged short replies found 9 failures in 28 cases, including incorrect approval of `취소해 줘.` on an agent progress card. The shared criteria currently include a hypothetical cancellation dialog even on registration cards. Ground the intent options in the actual pending card, clarify a cancellation/refusal of that proposal, and retain the strict approval, meta-instruction and permission-scope gates. Continue using decider for all intent classification; do not introduce a phrase-rule fallback.

Targets: `voice-wake.ts`, `voice-confirm.ts`, their tests and the existing live verification script. Verify logged short refusals on both cards, approval scope, actual cancellation dialogs, invalid output, stale requests and the normal wake/confirmation lifecycle. Synthetic live calls must not resolve real confirmations.

- [x] Reproduce the wake mismatch and retain the existing matcher without added aliases, per the user's latest direction.
- [x] Fix contextual intent questions and validate all 28 live examples, including exact short replies from the log.
- [x] Run related tests, renderer/node type checks and review the diff.

Cancellation validation: the original prompt failed 9/28 live cases; the corrected prompt passed 28/28 with the same probability gates. Both progress and browser registration cards now classify the logged short cancel/stop replies as rejection in the live synthetic test. Actual cancellation dialogs still distinguish agreeing to cancel from declining cancellation. No real confirmation was resolved by verification.

Final follow-up checks: 53/53 related tests and both renderer/node type checks passed with the existing temporary native-fs mapping. The production wake matcher has no added spelling aliases; the two new wake tests pin that boundary. Real microphone-to-card behavior still needs a restarted app and a fresh user attempt.

## Canonical ASR context hint, approved in this session

Add `context: "엑스젠"` to the existing Dex STT WebSocket start message in `voice-stream.ts`. The local core already accepts `start.context` and sends it as the upstream prompt; do not edit/restart model or core services and do not add misrecognition aliases. Pin the outgoing message in `voice-stream.test.ts`, then check the actual server's `ready.context` echo without sending audio or resolving a confirmation.

- [x] Verify outgoing start message, related tests and renderer/node types.
- [x] Check actual server context acceptance; distinguish that from measured ASR improvement.

Live handshake verification: dev XGEN returned `ready.context = "엑스젠"`, provider `custom`, and a Qwen3-ASR-1.7B model path. The check sent no audio and closed the session after ready; no model/core service was restarted. This proves hint acceptance at the deployed stream endpoint, not an ASR accuracy improvement or a microphone E2E result.

## Configured wake-list context, approved in this session

Replace the fixed brand hint with the session's configured wake-word list, joined by `, `. Reuse the existing comma/newline parser and its trim/empty/short-word handling; do not introduce another setting or change saved configuration. Omit context if wake is off, there are no valid words, or the existing raw-STT test mode bypasses wake handling. New sessions read the latest list as before.

Targets: `voice-stream.ts` and `voice-stream.test.ts`. Verify the serialized start message, off/empty/raw cases and list changes between sessions. Check actual server acceptance using a synthetic list without audio. No model/core restart or edit.

- [x] Verify list serialization and existing behavior with tests and type checks.
- [x] Check actual server `ready.context` for a comma-separated list.

Live handshake returned `context = "엑스젠, 자비스"` with the Qwen3-ASR-1.7B model. No audio was sent and no service was restarted. The list/off/change assertions failed before the production change. Multi-word microphone recognition remains a separate accuracy check.

## File-log tracing, approved in this session

Keep wake matching and all waits unchanged. Under the existing `DEX_WAKE_DEBUG=1` flag, trace the server's partial/final/done text, gate input/output, carry-over text, actual final-result wait, renderer delivery/carry/discard and chat/confirmation route. Use the same stream ID and ISO wall time across processes. Bound each text field to 300 characters and include original length/truncation flags. Reuse the redacting diagnostic sink and a small validated IPC for renderer events; no new UI or separate log file.

Add main trace/session and renderer lifecycle tests, including default-off logging, long text, stale results and preserved routing behavior. Run related tests and both type checks. Actual microphone traces require restarting Dex with the existing flag and reproducing the issue.

Confirmation routing also records whether the reply was stale/duplicate, remained unclear, failed, or requested/resolved approval/refusal/revision. Renderer trace transport is best effort and cannot interrupt the response if IPC closes.

Validation: 71 related tests passed, including the existing diagnostic/redaction suite, new trace bounds/default-off checks, actual session raw/gate/result correlation, continuation/carry logging and confirmation routing reasons. Renderer and node type checks passed with the existing temporary native-fs path mapping. No wake matching, timeout or continuation policy changed. Runtime file logging with a fresh microphone attempt has not yet been verified.
