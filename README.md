# PinkTree Voice Agent — starter scaffold

Outbound AI calling agent: Twilio (telephony) → Deepgram (STT + Aura TTS) → OpenRouter LLM (brain).

## Setup

```bash
npm install
cp .env.example .env
# fill in .env with your keys (Twilio, Deepgram, OpenRouter, DATA_DIR)
```

You'll need:
- A Twilio account + purchased phone number
- A Deepgram API key — covers both STT and TTS (Aura) now, one key for both
- An OpenRouter API key (openrouter.ai) — pick any model via `OPENROUTER_MODEL`
- Somewhere to store call logs/DNC data: a Railway Volume in production (set
  `DATA_DIR` to its mount path, e.g. `/data`), or just the local `./data`
  folder (default) for dev

## Admin panel — test without Twilio

Before wiring up a phone number at all, you can test the agent two ways,
neither of which touches Twilio or spends call minutes:

```bash
npm run dev
```

- **`http://localhost:3000/admin.html`** — the main panel. Record your mic
  and hear the agent talk back (real STT → LLM → TTS, just not over a phone
  line), plus tabs for call logs and the do-not-call list.
- **`http://localhost:3000/test.html`** — text-only version of the same
  conversation loop, if you'd rather type than talk.

## Local dev with real calls (Twilio needs a public HTTPS/WSS URL)

```bash
# terminal 1
npm run dev

# terminal 2 - expose localhost publicly
ngrok http 3000
```

Copy the ngrok hostname (no `https://`, no trailing slash) into `PUBLIC_HOSTNAME` in `.env`, then restart the server.

On first boot the server creates `DATA_DIR` (and its `call_events.jsonl` / `dnc_numbers.json` files) if they don't exist yet, and generates `public/voicemail.mp3` via Aura (cached after that — delete the file to regenerate if you change the voicemail text or voice).

## Make a test call

```bash
curl -X POST http://localhost:3000/call \
  -H "Content-Type: application/json" \
  -d '{"to": "+15551234567"}'
```

This dials the number, Twilio hits `/voice` for TwiML, which opens a Media
Stream WebSocket back to `/media-stream`. From there the loop runs:
caller audio → Deepgram STT → OpenRouter → Deepgram Aura TTS → back down the
same WebSocket to the caller. The call is rejected before dialing if the
number is on the DNC list, outside calling hours, or you're at the
concurrent-call cap (see below).

## What's implemented

- Outbound call trigger (`POST /call`)
- Twilio Media Stream wiring (raw audio in both directions)
- Streaming STT via Deepgram, tuned for phone audio (mu-law/8kHz)
- LLM brain via **OpenRouter** (`callLLM` helper, OpenAI-compatible chat
  completions endpoint) running a structured sales-call script — swap models
  anytime via `OPENROUTER_MODEL`, no code change needed.
- TTS via **Deepgram Aura** — same vendor/API key as STT. Live calls stream
  raw mu-law/8kHz directly (no transcoding); the admin panel and voicemail
  clip use a non-streaming mp3 call. Voice is configurable via `AURA_MODEL`.
- **Admin panel** (`GET /admin.html`):
  - **Voice test tab** — hold-to-record with your mic, the agent replies as
    real synthesized audio. Backed by `POST /admin/voice-start` (opening
    line) and `POST /admin/voice-chat` (your recorded audio in, transcript +
    LLM reply + spoken audio out). This is the closest thing to a real call
    without touching Twilio.
  - **Text test tab** — same conversation loop, typed instead of spoken.
    Backed by `POST /test/start` / `POST /test/chat`. Also available
    standalone at `GET /test.html`.
  - **Call logs tab** — reads `GET /logs`.
  - **Do-not-call tab** — reads/writes `GET /dnc` / `POST /dnc`.
- Barge-in: if the caller starts talking while the agent is playing audio, playback is cut immediately (`clear` event to Twilio)
- **Voicemail detection + matching voice**: `machineDetection` flags the
  answer as a machine; `/voice` then plays a pre-generated Aura clip
  (`public/voicemail.mp3`, same voice as the live agent, generated once on
  startup) instead of Twilio's built-in TTS.
- **Call logging + outcome tagging on a Railway Volume**: every call appends a
  JSON line to `DATA_DIR/call_events.jsonl` (initiation, ringing/answered/
  completed status, voicemail detection, and on hangup the full transcript
  plus an auto-classified outcome: `booked_demo` / `interested_followup` /
  `not_interested` / `wrong_person` / `do_not_call` / `unclear`), tagged by
  one extra LLM call over the transcript.
- **Do-not-call list**: a `DATA_DIR/dnc_numbers.json` file, checked before
  every outbound dial. Add numbers manually or let the system add them
  automatically — if the outcome classifier detects an explicit "remove me" /
  "stop calling" during a call, that number is added on hangup.
- **Calling-hours guard**: `/call` refuses to dial outside the window set by
  `CALL_HOURS_TZ` / `CALL_HOURS_START` / `CALL_HOURS_END` in `.env`.
- **Concurrency cap**: `/call` refuses new dials once `MAX_CONCURRENT_CALLS`
  live calls are already in progress, so a burst of dials can't overwhelm the
  Deepgram/OpenRouter connections.
- **Error recovery**: if the LLM call fails mid-conversation, the agent says
  "sorry, could you repeat that?" instead of going silent; after 2
  consecutive failures it ends the call gracefully with an apology instead of
  looping forever.
- **Sales script**: `SYSTEM_PROMPT` in `server.js` has a full call structure —
  opening, gatekeeper handling (get past sales agents to the actual
  decision-maker), qualifying question, pitch, objection handling (including
  explicit opt-out), and close. The specific pitch/value-prop wording is
  still a placeholder — swap in your real positioning once it's settled.

## What's NOT implemented yet (next steps)

- **Storage is file-based, not a real database**: `call_events.jsonl` /
  `dnc_numbers.json` on a Railway Volume work fine for one instance and
  moderate call volume, but there's no query/filtering beyond "most recent
  N events," and concurrent writes from multiple instances aren't safe. Fine
  as a temporary setup — move back to Postgres (or SQLite on the volume) if
  you scale to multiple instances or need real querying.
- **Real pitch wording**: the call structure is done; the actual sales
  copy in `SYSTEM_PROMPT` (step 4, "PITCH") is still generic placeholder text.
- **Regional calling-hours nuance**: the calling-hours guard uses one
  timezone for all calls — fine if you're calling one region, not if
  `to` numbers span multiple countries/timezones.
- **Retry logic for dropped Media Streams**: if the Twilio WebSocket drops
  mid-call (not a normal hangup), the call just ends — no reconnect attempt.
- **No auth on the admin panel/API routes**: `/admin.html`, `/logs`, `/dnc`,
  etc. are open to anyone with the URL. Fine while testing privately, add
  basic auth before sharing the domain or going live.
- **Real-world tuning**: none of this has run against actual phone calls yet.
  Expect to tune STT endpointing, barge-in sensitivity, and voicemail
  detection accuracy once you're testing on real lines.

## Suggested next milestone

Get one real end-to-end call working (steps in this order tend to surface
issues fastest):
0. Run the sales script end-to-end via `/admin.html` (voice or text tab, no
   phone needed) and tune `SYSTEM_PROMPT` until it reads well as a conversation
1. Confirm audio round-trips (`/call` → hear the agent's opening line)
2. Confirm Deepgram is transcribing your replies (watch server logs)
3. Confirm LLM replies make sense and TTS plays them back
4. Test barge-in by talking over the agent mid-sentence
5. Test the voicemail branch (call from a phone that goes to voicemail)
6. Swap in the real pitch wording
