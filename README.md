# Decoder Lifecycle

Unified hardware/software decoder lifecycle with conditional fallback.
Fixes the class of bugs where a browser without H.265 support leaves the
player believing a decoder is open, then wedges the whole page.

Pure TypeScript on the Node.js standard library (>= 22.18, type stripping).
Browser adapters use WebCodecs; rendering targets (Canvas, WebAudio,
MediaSource) sit downstream of the `onFrame` callback. Zero dependencies,
fully offline.

## Unified state machine

Both hardware and software backends are wrapped in the same
`DecoderLifecycle` (`src/lifecycle.ts`), so probe, open, feed, pause,
reset and release behave identically no matter what is underneath:

```
idle -> probing -> opening -> ready -> decoding <-> paused
                     |            ^       |
                     v            |       v
                   failed <- resetting <-+
                     |
any state -> releasing -> released
```

Illegal transitions throw a fatal `DecoderError`; `release()` is
idempotent and reachable from every state, including `failed`.

## Fallback policy

`PlayerDecoder` (`src/player.ts`) owns one active lifecycle and swaps
backends when all conditions hold:

- error is non-fatal (caller bugs never trigger a fallback);
- the fallback budget (`maxFallbacks`, default 1) is not exhausted;
- the next backend's probe accepts the codec.

Errors are classified by phase — `probe`, `open`, `first-frame`,
`mid-stream` — and all are fallbackable. On mid-stream fallback the
player replays every packet since the last keyframe into the fresh
decoder, so no frame is lost and the page never sees a stuck state.

## Layout

- `src/types.ts` — shared types, `DecoderError` with failure phase
- `src/backend.ts` — backend primitive interface
- `src/lifecycle.ts` — the unified state machine
- `src/player.ts` — fallback orchestration + keyframe replay
- `src/backends/webcodecs.ts` — hardware via WebCodecs `VideoDecoder`
- `src/backends/software.ts` — pure-TS software fallback decoder
- `src/backends/simulated.ts` — scripted backends: "declares support but
  cannot open" and "dies mid-stream"

## Run

```
npm test     # node --test test/*.test.ts
npm run demo # replays both failure scenarios end to end
```
