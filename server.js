import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import twilio from 'twilio';
import { createClient as createDeepgramClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import fetch from 'node-fetch';
import fsSync from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import crypto from 'crypto';

// Converts whatever a TTS provider hands back (mp3, pcm, whatever) into raw
// mu-law/8kHz - the exact format Twilio's Media Streams expect. Needed
// because OpenRouter's TTS endpoint doesn't offer mu-law/8kHz directly the
// way Deepgram Aura does. ffmpeg auto-detects the input format/sample rate
// from the file header, so this works regardless of what a given provider
// actually returns - verified against real MP3 output before shipping this.
function transcodeToMulaw8k(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, ['-i', 'pipe:0', '-f', 'mulaw', '-ar', '8000', '-ac', '1', 'pipe:1']);
    const chunks = [];
    let stderr = '';
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => { stderr += chunk; });
    ffmpeg.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      resolve(Buffer.concat(chunks));
    });
    ffmpeg.on('error', reject);
    ffmpeg.stdin.write(inputBuffer);
    ffmpeg.stdin.end();
  });
}

// Wraps raw mu-law bytes (what Twilio and our TTS pipeline use internally)
// in a minimal WAV header so it can be played back by a plain <audio> tag -
// used only for bulk-test sample clips, never for the live-call path.
function wrapMulawAsWav(mulawBuffer, sampleRate = 8000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + mulawBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(7, 20); // format tag 7 = mu-law
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28); // byte rate (1 byte/sample for 8-bit mu-law)
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(mulawBuffer.length, 40);
  return Buffer.concat([header, mulawBuffer]);
}

// ---- File-based storage on a Railway Volume --------------------------------
// Set DATA_DIR to your Railway volume's mount path (e.g. /data) in production
// so this survives restarts/redeploys. Falls back to ./data for local dev.
//   call_events.jsonl  - append-only log of every call event
//   dnc_numbers.json   - JSON array of do-not-call entries
//   contacts.json      - JSON array of imported contacts (CSV/XLSX)
//   system_prompt.txt  - the live sales script, editable from the admin panel
//   opening_line.txt   - the opening-line template, editable from the admin panel
//   tts_config.json    - which TTS provider/model live calls use, editable from the admin panel
//   request_logs.jsonl - per-request latency + estimated cost for every STT/LLM/TTS call
const DATA_DIR = process.env.DATA_DIR || './data';
const CALL_EVENTS_PATH = path.join(DATA_DIR, 'call_events.jsonl');
const DNC_PATH = path.join(DATA_DIR, 'dnc_numbers.json');
const CONTACTS_PATH = path.join(DATA_DIR, 'contacts.json');
const SCRIPT_PATH = path.join(DATA_DIR, 'system_prompt.txt');
const OPENING_PATH = path.join(DATA_DIR, 'opening_line.txt');
const TTS_CONFIG_PATH = path.join(DATA_DIR, 'tts_config.json');
const REQUEST_LOG_PATH = path.join(DATA_DIR, 'request_logs.jsonl');
const APP_CONFIG_PATH = path.join(DATA_DIR, 'app_config.json');

function ensureDataFiles() {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
  if (!fsSync.existsSync(CALL_EVENTS_PATH)) fsSync.writeFileSync(CALL_EVENTS_PATH, '');
  if (!fsSync.existsSync(DNC_PATH)) fsSync.writeFileSync(DNC_PATH, '[]');
  if (!fsSync.existsSync(CONTACTS_PATH)) fsSync.writeFileSync(CONTACTS_PATH, '[]');
  if (!fsSync.existsSync(REQUEST_LOG_PATH)) fsSync.writeFileSync(REQUEST_LOG_PATH, '');
  // system_prompt.txt / opening_line.txt / tts_config.json are seeded by
  // their own load*() functions further down, once their defaults exist.
}

function logCallEvent(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try {
    fsSync.appendFileSync(CALL_EVENTS_PATH, line);
  } catch (err) {
    console.error('Failed to log call event:', err);
  }
}

// Reversed (newest first), capped at `limit` - matches what /logs used to
// return from Postgres (`ORDER BY ts DESC LIMIT 200`).
function readCallEvents(limit = 200) {
  const raw = fsSync.readFileSync(CALL_EVENTS_PATH, 'utf-8').trim();
  if (!raw) return [];
  const lines = raw.split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
}

// Unfiltered, chronological - used for analytics and "already called"
// lookups where we need the full history, not just the most recent page.
function readAllCallEvents() {
  const raw = fsSync.readFileSync(CALL_EVENTS_PATH, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readContacts() {
  try {
    return JSON.parse(fsSync.readFileSync(CONTACTS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function writeContacts(list) {
  fsSync.writeFileSync(CONTACTS_PATH, JSON.stringify(list, null, 2));
}

// Merge newly imported rows into the existing contact list, deduping by
// phone number (last import wins on name/company for that number).
function mergeContacts(newRows) {
  const existing = readContacts();
  const byPhone = new Map(existing.map((c) => [c.phone, c]));
  let added = 0, updated = 0;
  for (const row of newRows) {
    if (!row.phone) continue;
    if (byPhone.has(row.phone)) {
      updated++;
    } else {
      added++;
    }
    byPhone.set(row.phone, { ...byPhone.get(row.phone), ...row });
  }
  const merged = Array.from(byPhone.values());
  writeContacts(merged);
  return { added, updated, total: merged.length };
}

// Every call_initiated event for this number, newest first - used both to
// warn "already called" before dialing and to show call history per contact.
function getCallHistoryForNumber(phoneNumber) {
  return readAllCallEvents()
    .filter((e) => (e.to || e.to_number) === phoneNumber && ['call_initiated', 'stream_ended', 'voicemail_detected'].includes(e.event))
    .reverse();
}

// ---- Cost tracking ----------------------------------------------------
// Rates below are manually maintained from each provider's published
// pricing as of when this was built (Sept 2026) - they will drift as
// providers change prices. Treat these as directional/comparative, not
// exact billing reconciliation. Unknown models return a null cost rather
// than a guess.
const MODEL_PRICING = {
  // LLM - $ per token
  'anthropic/claude-sonnet-4.5': { type: 'llm', inputPerToken: 3 / 1e6, outputPerToken: 15 / 1e6 },
  'anthropic/claude-haiku-4.5': { type: 'llm', inputPerToken: 1 / 1e6, outputPerToken: 5 / 1e6 },
  'deepseek/deepseek-v4-flash': { type: 'llm', inputPerToken: 0.1 / 1e6, outputPerToken: 0.2 / 1e6 },
  'meta-llama/llama-3.3-70b-instruct': { type: 'llm', inputPerToken: 0.59 / 1e6, outputPerToken: 0.79 / 1e6 },
  // TTS - $ per character
  'aura-asteria-en': { type: 'tts', perChar: 0.015 / 1000 },
  'aura-2': { type: 'tts', perChar: 0.03 / 1000 },
  'hexgrad/kokoro-82m': { type: 'tts', perChar: 0.62 / 1e6 },
  'openai/gpt-4o-mini-tts': { type: 'tts', perChar: 15 / 1e6 }, // conservative - published figures for this model conflicted between sources
  // Self-hosted (e.g. Kokoro-FastAPI) has no per-request billing - cost is
  // your hosting bill, not something to track per-call. $0 here is
  // deliberate and correct, unlike an untracked model returning null/unknown.
  'kokoro': { type: 'tts', perChar: 0 },
  // STT - $ per minute of audio
  'nova-2-phonecall': { type: 'stt', perMinute: 0.006 },
};

function estimateCost(model, usage) {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;
  if (pricing.type === 'llm') {
    return (usage.inputTokens || 0) * pricing.inputPerToken + (usage.outputTokens || 0) * pricing.outputPerToken;
  }
  if (pricing.type === 'tts') {
    return (usage.chars || 0) * pricing.perChar;
  }
  if (pricing.type === 'stt') {
    return ((usage.durationMs || 0) / 60000) * pricing.perMinute;
  }
  return null;
}

// One line per request to any STT/LLM/TTS provider - latency and estimated
// cost, so provider/model choices can be compared from real usage instead
// of guessing from price sheets.
function logRequestEvent(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try {
    fsSync.appendFileSync(REQUEST_LOG_PATH, line);
  } catch (err) {
    console.error('Failed to log request event:', err);
  }
}

function readRequestLogs(limit = 500) {
  const raw = fsSync.readFileSync(REQUEST_LOG_PATH, 'utf-8').trim();
  if (!raw) return [];
  const lines = raw.split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
}

function readAllRequestLogs() {
  const raw = fsSync.readFileSync(REQUEST_LOG_PATH, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readDncList() {
  try {
    return JSON.parse(fsSync.readFileSync(DNC_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function isOnDncList(phoneNumber) {
  return readDncList().some((e) => e.phone_number === phoneNumber);
}

function addToDncList(phoneNumber, reason) {
  const list = readDncList();
  if (list.some((e) => e.phone_number === phoneNumber)) return;
  list.push({ phone_number: phoneNumber, reason: reason || null, added_at: new Date().toISOString() });
  fsSync.writeFileSync(DNC_PATH, JSON.stringify(list, null, 2));
}

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  TELNYX_API_KEY,
  TELNYX_CONNECTION_ID,
  TELNYX_PHONE_NUMBER,
  TELNYX_PUBLIC_KEY,
  DEEPGRAM_API_KEY,
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5',
  // Post-call outcome tagging never talks to the caller - it reads a
  // finished transcript and picks one label. That's a job a much cheaper
  // model handles just as well as the conversation model, so it's a
  // separate, deliberately cheap default (Haiku 4.5 is ~3x cheaper than
  // Sonnet 4.5 on both input and output). Zero quality risk to the actual
  // call since this runs after it's already over.
  CLASSIFIER_MODEL = 'anthropic/claude-haiku-4.5',
  // Prompt caching (Anthropic models only, via OpenRouter's pass-through of
  // cache_control) can cut the repeated system-prompt tokens sent on every
  // turn by ~90% after the first turn - meaningful on longer calls, where
  // the same script text otherwise gets rebilled turn after turn. Off by
  // default: this couldn't be verified against a live OpenRouter endpoint
  // from the sandbox this was built in. Turn on and test a real call before
  // trusting it - if it's silently ignored by your chosen model/provider,
  // the call still works fine, you just won't see the cache-read discount.
  ENABLE_PROMPT_CACHING = 'false',
  AURA_MODEL = 'aura-asteria-en', // Deepgram TTS voice - see deepgram.com/docs for the full list
  PORT = 3000,
  PUBLIC_HOSTNAME,
  // Compliance / rate-limiting knobs - tune per the market you're calling into.
  CALL_HOURS_TZ = 'America/New_York',
  CALL_HOURS_START = '9',  // 24h, local to CALL_HOURS_TZ
  CALL_HOURS_END = '20',   // 24h, local to CALL_HOURS_TZ
  MAX_CONCURRENT_CALLS = '5',
  // How long Deepgram waits after the caller stops talking before firing
  // UtteranceEnd (turn-end signal). Lower = snappier but more likely to cut
  // people off mid-thought; higher = more patient but slower to respond.
  // 1000ms is a reasonable middle ground - tune per how "pausey" your
  // callers tend to be.
  UTTERANCE_END_MS = '1000',
} = process.env;

const deepgram = createDeepgramClient(DEEPGRAM_API_KEY);

// ---- Operational settings - admin-editable, hot-reloadable ----------------
// Deliberately NOT here: DEEPGRAM_API_KEY, OPENROUTER_API_KEY - those stay
// in env vars only. Telephony credentials (Twilio/Telnyx) are the one
// exception - they live in telephonyConfig below instead, specifically so
// the provider and its credentials can be switched from the admin panel
// without a redeploy. See the fieldnote in the admin panel's Telephony
// section for the tradeoff that comes with that (no login on this panel
// yet, so anything editable here is effectively public).
const DEFAULT_APP_CONFIG = {
  callHoursTz: CALL_HOURS_TZ,
  callHoursStart: parseInt(CALL_HOURS_START, 10),
  callHoursEnd: parseInt(CALL_HOURS_END, 10),
  maxConcurrentCalls: parseInt(MAX_CONCURRENT_CALLS, 10),
  openRouterModel: OPENROUTER_MODEL,
  classifierModel: CLASSIFIER_MODEL,
  utteranceEndMs: parseInt(UTTERANCE_END_MS, 10),
};
let appConfig = { ...DEFAULT_APP_CONFIG };

function loadAppConfig() {
  const existing = fsSync.existsSync(APP_CONFIG_PATH) ? fsSync.readFileSync(APP_CONFIG_PATH, 'utf-8') : '';
  if (existing.trim()) {
    try {
      appConfig = { ...DEFAULT_APP_CONFIG, ...JSON.parse(existing) };
      return;
    } catch {
      // fall through to reseed below
    }
  }
  fsSync.writeFileSync(APP_CONFIG_PATH, JSON.stringify(DEFAULT_APP_CONFIG, null, 2));
  appConfig = { ...DEFAULT_APP_CONFIG };
}

// ---- Telephony provider - which service places outbound calls -------------
// Switchable from the admin panel's Telephony section (Settings tab) with no
// redeploy: pick Twilio or Telnyx, drop in that provider's credentials, and
// /call starts routing through it immediately. Both providers' credentials
// are kept here (rather than only the *active* one) so switching back and
// forth doesn't lose whichever set isn't currently selected.
const TELEPHONY_CONFIG_PATH = path.join(DATA_DIR, 'telephony_config.json');
const DEFAULT_TELEPHONY_CONFIG = {
  provider: 'twilio', // 'twilio' | 'telnyx'
  twilioAccountSid: TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: TWILIO_AUTH_TOKEN || '',
  twilioPhoneNumber: TWILIO_PHONE_NUMBER || '',
  telnyxApiKey: TELNYX_API_KEY || '',
  telnyxConnectionId: TELNYX_CONNECTION_ID || '',
  telnyxPhoneNumber: TELNYX_PHONE_NUMBER || '',
};
let telephonyConfig = { ...DEFAULT_TELEPHONY_CONFIG };

function loadTelephonyConfig() {
  const existing = fsSync.existsSync(TELEPHONY_CONFIG_PATH) ? fsSync.readFileSync(TELEPHONY_CONFIG_PATH, 'utf-8') : '';
  if (existing.trim()) {
    try {
      telephonyConfig = { ...DEFAULT_TELEPHONY_CONFIG, ...JSON.parse(existing) };
      return;
    } catch {
      // fall through to reseed below
    }
  }
  fsSync.writeFileSync(TELEPHONY_CONFIG_PATH, JSON.stringify(DEFAULT_TELEPHONY_CONFIG, null, 2));
  telephonyConfig = { ...DEFAULT_TELEPHONY_CONFIG };
}

// Built fresh from whatever's currently saved rather than cached at startup,
// so a credential rotated in the admin panel takes effect on the very next
// call - no restart needed.
function getTwilioClient() {
  return twilio(telephonyConfig.twilioAccountSid, telephonyConfig.twilioAuthToken);
}

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

// Thin wrapper around Telnyx's Call Control REST API (same shape for every
// command: POST a JSON body, get `{ data: {...} }` back). Not verified
// against a live Telnyx account from the sandbox this was built in - the
// request/webhook shapes match Telnyx's published API reference as of when
// this was written, but test a real outbound call before relying on it.
async function telnyxRequest(method, pathSuffix, body) {
  const res = await fetch(`${TELNYX_API_BASE}${pathSuffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${telephonyConfig.telnyxApiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || res.statusText;
    throw new Error(`Telnyx API error (${res.status}): ${detail}`);
  }
  return data;
}

// callControlId -> { to } for calls placed via Telnyx, from dial time until
// the webhook flow either starts the media stream or hangs the call up.
// Needed because unlike Twilio's synchronous /voice fetch, Telnyx's dial
// call returns immediately and the callee number has to be recovered later
// from a webhook that only carries the call_control_id.
const pendingTelnyxCalls = new Map();

// ---- TTS, via Deepgram Aura ------------------------------------------------
// One vendor for both STT and TTS (same DEEPGRAM_API_KEY). Used by live
// calls (streaming, mu-law/8kHz to match Twilio directly), the voicemail
// clip, and the admin voice-test panel (mp3, non-streaming).
async function synthesizeSpeechMp3(text) {
  const res = await fetch(
    `https://api.deepgram.com/v1/speak?model=${AURA_MODEL}&encoding=mp3`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    }
  );
  if (!res.ok) throw new Error(`Deepgram Aura TTS failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const promptCachingEnabled = ENABLE_PROMPT_CACHING === 'true';

// When enabled, marks the system prompt as cacheable (Anthropic-style
// cache_control, which OpenRouter passes through for Anthropic models).
// The conversation history still grows and isn't cached - only the fixed
// system prompt is - but that's the part that otherwise gets re-billed in
// full on every single turn of a call.
function buildSystemMessage(system) {
  if (!promptCachingEnabled) return { role: 'system', content: system };
  return {
    role: 'system',
    content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
  };
}

// ---- LLM brain, via OpenRouter (OpenAI-compatible chat completions) -------
// Used both by live calls and the no-Twilio /test chat panel below.
async function callLLM({ system, messages, maxTokens = 200, model = appConfig.openRouterModel, source = 'call' }) {
  const start = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      // OpenRouter asks for these on every request; used for their dashboard
      // attribution/rankings, not required for calls to work.
      'HTTP-Referer': PUBLIC_HOSTNAME ? `https://${PUBLIC_HOSTNAME}` : 'http://localhost',
      'X-Title': 'PinkTree Voice Agent',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [buildSystemMessage(system), ...messages],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  logRequestEvent({
    type: 'llm',
    model,
    source,
    inputTokens: data.usage?.prompt_tokens || null,
    outputTokens: data.usage?.completion_tokens || null,
    durationMs: Date.now() - start,
    estimatedCost: data.usage
      ? estimateCost(model, { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens })
      : null,
  });
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// Streaming variant, used only by live calls. Reads OpenRouter's SSE stream
// token-by-token and fires onSentence() as soon as each complete sentence
// appears - the caller (CallSession) starts TTS on sentence 1 immediately
// instead of waiting for the model to finish the whole reply. This is the
// single biggest latency win available here: time-to-first-audio drops from
// "however long the full reply takes to generate" to "however long the
// first sentence takes."
async function callLLMStream({ system, messages, maxTokens = 200, onSentence, model = appConfig.openRouterModel, source = 'call' }) {
  const start = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': PUBLIC_HOSTNAME ? `https://${PUBLIC_HOSTNAME}` : 'http://localhost',
      'X-Title': 'PinkTree Voice Agent',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true }, // OpenAI-compatible - asks for a final usage chunk so cost can be logged accurately instead of estimated from character counts
      messages: [buildSystemMessage(system), ...messages],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter error ${res.status}: ${errText}`);
  }

  let lineBuffer = '';     // raw SSE bytes that haven't formed a full line yet
  let sentenceBuffer = ''; // model text not yet flushed as a complete sentence
  let fullText = '';
  let usage = null;

  // Pulls one complete sentence off the front of sentenceBuffer, if there is
  // one. `force` flushes whatever's left even without terminal punctuation -
  // used once at the end of the stream so a reply with no trailing "." still
  // gets spoken.
  function flushSentence(force = false) {
    const match = sentenceBuffer.match(/^(.*?[.!?])(\s+|$)/);
    if (match) {
      sentenceBuffer = sentenceBuffer.slice(match[0].length);
      const sentence = match[1].trim();
      if (sentence) onSentence(sentence);
      return true;
    }
    if (force && sentenceBuffer.trim()) {
      onSentence(sentenceBuffer.trim());
      sentenceBuffer = '';
    }
    return false;
  }

  for await (const chunk of res.body) {
    lineBuffer += chunk.toString('utf-8');
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // last line may be incomplete - keep for next chunk

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          sentenceBuffer += delta;
          fullText += delta;
          while (flushSentence()) {} // flush every sentence that's now complete
        }
        if (json.usage) usage = json.usage; // arrives once, in the final chunk
      } catch {
        // A single SSE chunk occasionally splits mid-JSON across network
        // reads - the remainder completes it on the next chunk, safe to skip.
      }
    }
  }
  flushSentence(true);
  logRequestEvent({
    type: 'llm',
    model,
    source,
    inputTokens: usage?.prompt_tokens || null,
    outputTokens: usage?.completion_tokens || null,
    durationMs: Date.now() - start,
    estimatedCost: usage
      ? estimateCost(model, { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens })
      : null,
  });
  return fullText.trim();
}

// Raw mu-law/8kHz synthesis (no streaming) - the shared primitive behind
// backchannel clips, fallback clips, and prefetched sentence audio during
// live calls. All three want the same encoding, just at different times.
async function synthesizeSpeechMulaw(text, model = AURA_MODEL) {
  const res = await fetch(
    `https://api.deepgram.com/v1/speak?model=${model}&encoding=mulaw&sample_rate=8000&container=none`,
    {
      method: 'POST',
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }
  );
  if (!res.ok) throw new Error(`Aura TTS failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- Backchanneling ---------------------------------------------------
// Short acknowledgment clips ("mm-hmm", "got it") pre-generated once at
// startup and cached in memory as raw mu-law audio. Playing one immediately
// when the caller finishes talking - before the LLM has even responded -
// fills the silence naturally and masks LLM/TTS latency, the same way a
// human on a call says "mm-hmm" while thinking of what to say next.
const BACKCHANNEL_PHRASES = ['Mm-hmm.', 'I see.', 'Got it.', 'Right.', 'Okay.'];
let backchannelClips = [];

async function ensureBackchannelClips() {
  const buffers = [];
  for (const phrase of BACKCHANNEL_PHRASES) {
    try {
      buffers.push(await synthesizeSpeechMulaw(phrase));
    } catch (err) {
      console.error(`Backchannel clip "${phrase}" failed to generate:`, err.message);
    }
  }
  backchannelClips = buffers;
  console.log(`Generated ${buffers.length}/${BACKCHANNEL_PHRASES.length} backchannel clips`);
}

// ---- Fallback clips for LLM failures -----------------------------------
// Pre-generated so the error path itself doesn't need a TTS round-trip -
// something's already gone wrong at that point, no reason to add more
// latency (or a second failure point) on top of it.
const FALLBACK_TEXT = {
  retry: "Sorry, I didn't quite catch that - could you say that again?",
  giveUp: "Sorry, I'm having trouble with the line. I'll follow up by email instead. Thanks for your time.",
};
let fallbackClips = {};

async function ensureFallbackClips() {
  for (const [key, text] of Object.entries(FALLBACK_TEXT)) {
    try {
      fallbackClips[key] = await synthesizeSpeechMulaw(text);
    } catch (err) {
      console.error(`Fallback clip "${key}" failed to generate:`, err.message);
    }
  }
}

// ---- Opt-out fast path --------------------------------------------------
// An explicit "stop calling me" is a compliance-critical moment that's also
// one of the cheapest turns to optimize: skip the LLM and live TTS entirely
// (pure savings), respond with a guaranteed-correct pre-generated
// confirmation (arguably more reliable here than letting the LLM improvise
// the exact wording), then hang up immediately instead of running further
// billable call minutes. Deliberately conservative pattern - a missed match
// just falls through to the normal LLM path and the script's own opt-out
// handling in SYSTEM_PROMPT still catches it there, so a false negative
// costs nothing extra; a false positive would end a call prematurely, which
// is why this only matches unambiguous phrasing.
const OPT_OUT_PATTERN =
  /\b(stop calling|remove me from|take me off|don'?t call (me )?again|do not call (me )?again|do not call list|unsubscribe)\b/i;

function detectOptOutIntent(text) {
  return OPT_OUT_PATTERN.test(text);
}

const OPT_OUT_CONFIRMATION_TEXT =
  "Understood, I'll remove your number from our calling list right away. Thanks for your time, have a good day.";
let optOutClip = null;

async function ensureOptOutClip() {
  optOutClip = await synthesizeSpeechMulaw(OPT_OUT_CONFIRMATION_TEXT);
}

// ~150ms of silence between sentences (G.711 mu-law silence = byte 0xFF) so
// back-to-back sentences sound like natural speech cadence instead of one
// continuous run-on blob.
const SENTENCE_PAUSE_SAMPLES = Math.round(8000 * 0.15);

// Tracks calls currently in the live Media Stream loop, so /call can refuse
// new dials once at capacity instead of overwhelming the STT/LLM/TTS APIs.
const activeCallSids = new Set();

// TODO: replace with a real per-region calling-hours check if you operate
// across timezones tied to the callee's location rather than a single one.
function isWithinCallingHours() {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: appConfig.callHoursTz,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  const hour = parseInt(hourStr, 10);
  return hour >= appConfig.callHoursStart && hour < appConfig.callHoursEnd;
}

// ---- Sales script / system prompt -----------------------------------------
// This is the DEFAULT/fallback text. The live, editable version is stored at
// DATA_DIR/system_prompt.txt and edited via the Script tab in /admin.html
// (GET/POST /admin/script) - changes take effect immediately, no redeploy.
const DEFAULT_SYSTEM_PROMPT = `You are an outbound caller for PinkTree
(pinktreee.com), a website + AI chatbot product for visa consultants and
survey companies. You're calling a business that may only pick up through a
sales agent or front-desk line rather than the owner/decision-maker directly
- your first job on many calls is getting past that gatekeeper, not pitching
them.

RULES FOR EVERY TURN
- 1-2 short sentences per turn. This is a live phone call, not chat - long
  answers make you sound like a recording.
- Never read a list or use markdown. Speak naturally, like a person.
- Ask one question at a time and wait for the answer.
- If you don't understand what the person said, ask them to repeat rather
  than guessing.

CALL FLOW

1. OPENING (first turn, right after connect)
   Identify yourself and PinkTree in one breath, say why you're calling, ask
   for the decision-maker by role if you don't have a name.
   e.g. "Hi, this is [name] calling from PinkTree - we help visa consulting
   firms convert more website visitors into clients. Am I speaking with the
   person who handles that, or could you point me to them?"

2. GATEKEEPER HANDLING
   If you're talking to a sales agent, receptionist, or anyone who isn't the
   decision-maker: be respectful, state your purpose briefly, and ask
   directly to be connected or for the decision-maker's direct line/email.
   Do not deliver the full pitch to a gatekeeper - it wastes the call and
   tips your hand before you can actually book anything. If they push back,
   ask when the decision-maker is usually reachable and offer to call back
   then.

3. QUALIFY (once you have the decision-maker)
   Confirm they're the right person and gauge quick interest before
   pitching: e.g. "Do you currently have a way for people who visit your
   website to actually get answers and book a consultation, or does that
   mostly happen by phone/WhatsApp?"

4. PITCH (keep to 1-2 sentences, tied to what they just said)
   PinkTree gives their website a chatbot that answers visitor questions and
   helps convert them into booked consultations automatically, so leads
   don't go cold waiting for a callback.

5. OBJECTION HANDLING
   - "Not interested" -> acknowledge once, ask if it's a timing thing or a
     genuine no, then let it go gracefully if they hold firm. Do not
     re-pitch a second time.
   - "Send me info by email" -> agree, but try to lock a specific day/time
     for a follow-up call before hanging up rather than leaving it open-ended.
   - "We already have something for this" -> ask briefly what they use
     (useful signal for later), don't argue, offer a no-pressure comparison
     demo instead of disputing their current setup.
   - "How much does it cost" -> don't quote pricing on this call; say pricing
     depends on their setup and that's exactly what the demo covers.
   - "Remove me from your list" / "stop calling me" -> confirm clearly that
     you will not call them again, thank them, and end the call immediately.
     Do not continue pitching after this.

6. CLOSE
   Goal is a booked 15-minute demo with the decision-maker, not a sale on
   this call. Ask for a specific day/time, confirm the best number/email to
   send the calendar invite to, thank them, end the call.

VOICEMAIL
   If you reach voicemail, leave one short message: who you are, why you
   called, and that you'll follow up by email - then stop talking (don't
   wait for a response).`;

// Mutable - reassigned by loadSystemPrompt() at startup and by POST
// /admin/script whenever someone saves an edit in the admin panel.
let systemPrompt = DEFAULT_SYSTEM_PROMPT;

function loadSystemPrompt() {
  const existing = fsSync.existsSync(SCRIPT_PATH) ? fsSync.readFileSync(SCRIPT_PATH, 'utf-8') : '';
  if (existing.trim()) {
    systemPrompt = existing;
  } else {
    // File missing OR present-but-empty (e.g. a volume mount that
    // pre-creates an empty placeholder file before the app's first write) -
    // either way, seed it with the real default instead of silently
    // running on an empty script.
    fsSync.writeFileSync(SCRIPT_PATH, DEFAULT_SYSTEM_PROMPT);
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }
}

// ---- Opening line: skipped past the LLM entirely -------------------------
// The opening line is the one turn of every call that doesn't benefit from
// generation - it's the same handful of sentences every time, just
// optionally naming the company. Routing it through the LLM (even
// streaming) still costs a real network round-trip at the single most
// latency-sensitive moment of the whole call: the silence right after
// someone picks up. So it's templated instead, with a tiny optional-clause
// syntax: {company} is a placeholder, and [[...{company}...]] is a block
// that's dropped entirely if company isn't known for this call.
const DEFAULT_OPENING_TEMPLATE =
  'Hi, this is Sarah calling from PinkTree[[ about {company}\'s website]] - ' +
  'we help visa consulting firms convert more website visitors into clients. ' +
  'Am I speaking with the right person to talk about that?';

let openingTemplate = DEFAULT_OPENING_TEMPLATE;

function loadOpeningTemplate() {
  const existing = fsSync.existsSync(OPENING_PATH) ? fsSync.readFileSync(OPENING_PATH, 'utf-8') : '';
  if (existing.trim()) {
    openingTemplate = existing;
  } else {
    fsSync.writeFileSync(OPENING_PATH, DEFAULT_OPENING_TEMPLATE);
    openingTemplate = DEFAULT_OPENING_TEMPLATE;
  }
}

// ---- Live-call TTS provider/model - editable from the admin panel --------
// Cached clips (backchannel, fallback, opt-out, generic opening) stay on
// Deepgram Aura always - they're generated once at startup, so their cost
// is fixed and negligible regardless of which provider is picked here. This
// setting only controls the per-sentence TTS used during actual live
// conversation, which is the part that scales with call volume/cost.
const DEFAULT_TTS_CONFIG = { provider: 'deepgram', model: 'aura-asteria-en', voice: null, baseUrl: null };
let ttsConfig = { ...DEFAULT_TTS_CONFIG };

function loadTtsConfig() {
  if (fsSync.existsSync(TTS_CONFIG_PATH)) {
    try {
      ttsConfig = JSON.parse(fsSync.readFileSync(TTS_CONFIG_PATH, 'utf-8'));
    } catch {
      ttsConfig = { ...DEFAULT_TTS_CONFIG };
    }
  } else {
    fsSync.writeFileSync(TTS_CONFIG_PATH, JSON.stringify(DEFAULT_TTS_CONFIG, null, 2));
    ttsConfig = { ...DEFAULT_TTS_CONFIG };
  }
}

// Fetches one sentence of live-call audio as mu-law/8kHz, routed through
// whichever provider is currently configured, and logs latency + estimated
// cost for it either way - this is the actual per-call cost driver, unlike
// the cached clips above.
async function fetchLiveSentenceAudio(text, source = 'call') {
  const start = Date.now();
  let buffer;

  if (ttsConfig.provider === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ttsConfig.model,
        input: text,
        ...(ttsConfig.voice ? { voice: ttsConfig.voice } : {}),
        response_format: 'mp3', // self-describing format, so ffmpeg gets the real sample rate regardless of what the provider actually returns
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenRouter TTS failed: ${res.status} ${errText}`);
    }
    const rawAudio = Buffer.from(await res.arrayBuffer());
    buffer = await transcodeToMulaw8k(rawAudio);
  } else if (ttsConfig.provider === 'self_hosted') {
    // Any OpenAI-compatible /v1/audio/speech server - built for Kokoro-FastAPI
    // (github.com/remsky/Kokoro-FastAPI) specifically, but works with anything
    // exposing the same shape. No proxy hop, no per-character billing - just
    // your own hosted latency (which is the whole point of self-hosting).
    if (!ttsConfig.baseUrl) throw new Error('self_hosted TTS provider has no baseUrl configured');
    const res = await fetch(`${ttsConfig.baseUrl.replace(/\/$/, '')}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ttsConfig.model || 'kokoro',
        input: text,
        ...(ttsConfig.voice ? { voice: ttsConfig.voice } : {}),
        response_format: 'wav', // self-describing, and skips a compression step the provider would otherwise spend time on
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Self-hosted TTS failed: ${res.status} ${errText}`);
    }
    const rawAudio = Buffer.from(await res.arrayBuffer());
    buffer = await transcodeToMulaw8k(rawAudio);
  } else {
    // Falls back to the AURA_MODEL env default if the saved config's model
    // doesn't look like a Deepgram Aura model - covers the case where it
    // was left over from switching provider away from OpenRouter in the
    // admin panel without also resetting the model field.
    const deepgramModel = ttsConfig.model?.startsWith('aura') ? ttsConfig.model : AURA_MODEL;
    buffer = await synthesizeSpeechMulaw(text, deepgramModel);
  }

  const resolvedModel =
    ttsConfig.provider === 'deepgram'
      ? (ttsConfig.model?.startsWith('aura') ? ttsConfig.model : AURA_MODEL)
      : (ttsConfig.model || 'kokoro');
  logRequestEvent({
    type: 'tts',
    provider: ttsConfig.provider,
    model: resolvedModel,
    source,
    chars: text.length,
    durationMs: Date.now() - start,
    estimatedCost: estimateCost(resolvedModel, { chars: text.length }),
  });

  return buffer;
}

function renderOpeningLine(template, vars) {
  // Optional blocks: [[ ... {var} ... ]] - included only if every {var}
  // referenced inside it is present in `vars`; dropped entirely otherwise.
  let result = template.replace(/\[\[([^[\]]*?)\]\]/g, (whole, inner) => {
    const varNames = [...inner.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const missing = varNames.some((v) => !vars[v]);
    if (missing) return '';
    return inner.replace(/\{(\w+)\}/g, (_, v) => vars[v]);
  });
  // Any remaining top-level placeholders outside an optional block.
  result = result.replace(/\{(\w+)\}/g, (_, v) => vars[v] || '');
  return result.replace(/\s+/g, ' ').replace(/\s+([,.?!])/g, '$1').trim();
}

// The fully-generic render (no contact data) is cacheable - it's the same
// audio every time, so it's synthesized once at startup instead of on every
// call that doesn't match a known contact. Personalized (with company)
// still needs a live TTS call since the text genuinely varies.
let genericOpeningClip = null;

async function ensureGenericOpeningClip() {
  const text = renderOpeningLine(openingTemplate, {});
  genericOpeningClip = await synthesizeSpeechMulaw(text);
}

const app = express();
// Behind Railway's (or any) reverse proxy, req.ip is the proxy's address
// unless this is set - needed for the per-IP rate limit below to actually
// distinguish callers instead of limiting everyone as one bucket.
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
// Captures the exact raw bytes of the request body alongside the parsed
// JSON - Telnyx's webhook signature is computed over those exact raw
// bytes, so re-serializing the parsed body wouldn't reliably match.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static('public'));

// ---- Per-IP rate limit on /call ---------------------------------------------
// Simple in-memory sliding window - not meant to stop a determined attacker
// distributing requests across many IPs, just to contain a runaway bug or
// script that ends up blasting far more calls than intended. If this ever
// runs as more than one instance, each instance tracks its own counts
// independently (same caveat as the rest of this app's in-memory state).
const CALL_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CALL_RATE_LIMIT_MAX = 20; // per IP, per minute - generous for a human, tight for a bug
const callRateLimitLog = new Map(); // ip -> recent request timestamps (ms)

function isCallRateLimited(ip) {
  const now = Date.now();
  const recent = (callRateLimitLog.get(ip) || []).filter((t) => now - t < CALL_RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  callRateLimitLog.set(ip, recent);
  return recent.length > CALL_RATE_LIMIT_MAX;
}

// ---- Twilio webhook signature verification ---------------------------------
// Without this, anyone who finds /voice or /call-status can POST forged
// requests - fake "call answered" events, fake AnsweredBy values, etc.
// Twilio signs every webhook request with the account's Auth Token; this
// confirms a request actually came from Twilio before acting on it.
function requireTwilioSignature(req, res, next) {
  if (!telephonyConfig.twilioAuthToken) {
    console.warn(`Twilio auth token not configured - skipping signature check on ${req.path}. Set it in Settings > Telephony.`);
    return next();
  }
  const signature = req.headers['x-twilio-signature'];
  const url = `https://${PUBLIC_HOSTNAME}${req.originalUrl}`;
  const valid = twilio.validateRequest(telephonyConfig.twilioAuthToken, signature || '', url, req.body);
  if (!valid) {
    console.warn(`Rejected ${req.path}: invalid Twilio signature`);
    return res.status(403).send('Invalid signature');
  }
  next();
}

// ---- Telnyx webhook signature verification ----------------------------------
// Same reasoning as Twilio above, different mechanism: Telnyx signs with
// Ed25519 over "{timestamp}|{raw body}", verified against the public key
// from your Telnyx Mission Control Portal (account-level, set once as
// TELNYX_PUBLIC_KEY - unlike the API key/connection ID, this isn't a
// per-call-config credential, so it stays an env var rather than moving
// into the admin panel).
function verifyTelnyxSignature(req) {
  if (!TELNYX_PUBLIC_KEY) {
    console.warn('TELNYX_PUBLIC_KEY not configured - skipping signature check on /telnyx/webhook. Set it in .env (from the Mission Control Portal) to verify Telnyx webhooks are genuine.');
    return true;
  }
  const signatureHeader = req.headers['telnyx-signature-ed25519'];
  const timestampHeader = req.headers['telnyx-timestamp'];
  if (!signatureHeader || !timestampHeader || !req.rawBody) return false;

  // Reject anything older than 5 minutes - stops a captured request from
  // being replayed later.
  const timestamp = parseInt(timestampHeader, 10);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  try {
    const signedPayload = `${timestampHeader}|${req.rawBody.toString('utf-8')}`;
    const publicKeyBytes = Buffer.from(TELNYX_PUBLIC_KEY, 'base64');
    const keyObject = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBytes.toString('base64url') },
      format: 'jwk',
    });
    return crypto.verify(null, Buffer.from(signedPayload), keyObject, Buffer.from(signatureHeader, 'base64'));
  } catch (err) {
    console.error('Telnyx signature verification error:', err.message);
    return false;
  }
}

// ---- Outbound call placement -------------------------------------------------
// Shared by the manual /call endpoint and the auto-dialer below. Handles
// provider credential checks and the actual dial - does NOT check DNC,
// calling hours, or "already called" history, since the auto-dialer applies
// those at queue-build/pop time slightly differently than the interactive
// /call route does (no forceCall concept in an unattended queue).
//
// callsInFlight tracks every call from the moment it's dialed until it
// fully ends (terminal status webhook), which is deliberately broader than
// activeCallSids (added only once the media stream connects). A burst of
// calls that are still ringing/still running AMD wouldn't show up in
// activeCallSids yet, so gating concurrency on that alone could let more
// than maxConcurrentCalls go out at once - callsInFlight is the accurate
// count for that purpose.
const callsInFlight = new Set();
// If a terminal status webhook is ever lost (dropped connection, provider
// hiccup), a call would stay in callsInFlight forever and slowly starve the
// campaign's concurrency. Force-clear it after a generous ceiling - no real
// call legitimately runs this long - and let the next pump backfill.
const CALL_IN_FLIGHT_MAX_MS = 20 * 60 * 1000;
function trackCallInFlight(sid) {
  callsInFlight.add(sid);
  setTimeout(() => {
    if (callsInFlight.delete(sid)) {
      console.warn(`Call ${sid} never received a terminal status webhook after 20min - clearing it from the in-flight count.`);
      pumpCampaignQueue().catch((err) => console.error('Campaign pump error:', err.message));
    }
  }, CALL_IN_FLIGHT_MAX_MS);
}

async function placeCallToNumber(to) {
  const provider = telephonyConfig.provider || 'twilio';

  if (provider === 'twilio') {
    if (!telephonyConfig.twilioAccountSid || !telephonyConfig.twilioAuthToken) {
      return { ok: false, error: 'Twilio is selected as the voice provider but its Account SID / Auth Token are not set - add them in Settings > Telephony' };
    }
    if (!telephonyConfig.twilioPhoneNumber) {
      return { ok: false, error: 'no outbound caller ID configured - set it in Settings > Telephony' };
    }
  } else {
    if (!telephonyConfig.telnyxApiKey || !telephonyConfig.telnyxConnectionId) {
      return { ok: false, error: 'Telnyx is selected as the voice provider but its API Key / Connection ID are not set - add them in Settings > Telephony' };
    }
    if (!telephonyConfig.telnyxPhoneNumber) {
      return { ok: false, error: 'no outbound caller ID configured - set it in Settings > Telephony' };
    }
  }

  try {
    if (provider === 'twilio') {
      const call = await getTwilioClient().calls.create({
        to,
        from: telephonyConfig.twilioPhoneNumber,
        url: `https://${PUBLIC_HOSTNAME}/voice`, // Twilio fetches TwiML from here once answered
        // Synchronous machine detection: Twilio delays connecting the call
        // until it decides human vs. machine, then passes AnsweredBy to /voice.
        machineDetection: 'DetectMessageEnd',
        machineDetectionTimeout: 15,
        statusCallback: `https://${PUBLIC_HOSTNAME}/call-status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      });
      trackCallInFlight(call.sid);
      logCallEvent({ event: 'call_initiated', callSid: call.sid, to, provider: 'twilio' });
      return { ok: true, sid: call.sid, status: call.status };
    } else {
      // Telnyx's dial call returns before the call connects - everything
      // past this point (machine detection, opening the media stream,
      // voicemail playback) is driven by webhooks to /telnyx/webhook.
      const result = await telnyxRequest('POST', '/calls', {
        connection_id: telephonyConfig.telnyxConnectionId,
        to,
        from: telephonyConfig.telnyxPhoneNumber,
        webhook_url: `https://${PUBLIC_HOSTNAME}/telnyx/webhook`,
        answering_machine_detection: 'premium',
      });
      const callControlId = result.data.call_control_id;
      pendingTelnyxCalls.set(callControlId, { to });
      trackCallInFlight(callControlId);
      logCallEvent({ event: 'call_initiated', callSid: callControlId, to, provider: 'telnyx' });
      return { ok: true, sid: callControlId, status: 'queued' };
    }
  } catch (err) {
    console.error('Call creation failed:', err);
    return { ok: false, error: err.message };
  }
}

// ---- 1. Outbound call trigger ----------------------------------------------
// POST /call  { "to": "+15551234567", "forceCall": false }
app.post('/call', async (req, res) => {
  if (isCallRateLimited(req.ip)) {
    return res.status(429).json({ error: `too many calls placed too quickly - limit is ${CALL_RATE_LIMIT_MAX} per minute per IP` });
  }

  const { to, forceCall } = req.body;
  if (!to) return res.status(400).json({ error: 'missing "to" number' });

  if (isOnDncList(to)) {
    return res.status(403).json({ error: 'number is on the do-not-call list' });
  }
  if (!isWithinCallingHours()) {
    return res.status(403).json({
      error: `outside allowed calling hours (${appConfig.callHoursStart}:00-${appConfig.callHoursEnd}:00 ${appConfig.callHoursTz})`,
    });
  }
  if (callsInFlight.size >= appConfig.maxConcurrentCalls) {
    return res.status(429).json({ error: 'at max concurrent call capacity, try again shortly' });
  }

  // Already called this number before? Block unless the caller explicitly
  // confirms with forceCall - surfaces last outcome so the admin can decide.
  if (!forceCall) {
    const history = getCallHistoryForNumber(to);
    if (history.length > 0) {
      return res.status(409).json({
        error: 'already called this number before',
        alreadyCalled: true,
        history,
      });
    }
  }

  const result = await placeCallToNumber(to);
  if (!result.ok) return res.status(500).json({ error: result.error });
  res.json({ sid: result.sid, status: result.status });
});

// ---- Auto-dialer (campaign) -------------------------------------------------
// Dials down a queue of contacts automatically, keeping up to
// maxConcurrentCalls running at once - as soon as one call ends, the next
// queued contact is dialed to backfill it. Single queue at a time (no
// concept of multiple simultaneous campaigns); starting a new one while one
// is active is rejected rather than merged, to avoid surprising interleaving.
const CAMPAIGN_STATE_PATH = path.join(DATA_DIR, 'campaign_state.json');
let campaign = {
  active: false,
  queue: [],           // phone numbers not yet dialed
  dialedCount: 0,
  skippedCount: 0,      // hit DNC, or the dial itself failed
  startedAt: null,
  finishedAt: null,
};

function saveCampaignState() {
  try {
    fsSync.writeFileSync(CAMPAIGN_STATE_PATH, JSON.stringify(campaign, null, 2));
  } catch (err) {
    console.error('Failed to save campaign state:', err.message);
  }
}

function loadCampaignState() {
  if (!fsSync.existsSync(CAMPAIGN_STATE_PATH)) return;
  try {
    campaign = { ...campaign, ...JSON.parse(fsSync.readFileSync(CAMPAIGN_STATE_PATH, 'utf-8')) };
  } catch {
    // corrupt/partial write - start clean rather than crash on boot
  }
  // A queue that survives a restart shouldn't silently keep dialing without
  // anyone watching - require an explicit resume via /admin/campaign/start.
  if (campaign.active && campaign.queue.length > 0) {
    console.log(`Found ${campaign.queue.length} contact(s) left in a campaign queue from a previous run - it's paused; resume it from the Contacts tab.`);
  }
  campaign.active = false;
}

// Backfills the queue up to maxConcurrentCalls whenever there's room -
// called right after starting a campaign, and again every time a call ends
// (from the Twilio/Telnyx webhook handlers below) plus on a periodic timer
// as a safety net in case a webhook is ever missed.
let pumpInProgress = false;
async function pumpCampaignQueue() {
  if (!campaign.active || pumpInProgress) return;
  pumpInProgress = true;
  try {
    if (!isWithinCallingHours()) return; // periodic pump will retry once back in hours

    while (campaign.queue.length > 0 && callsInFlight.size < appConfig.maxConcurrentCalls) {
      const to = campaign.queue.shift();
      if (isOnDncList(to)) {
        campaign.skippedCount++;
        continue;
      }
      const result = await placeCallToNumber(to);
      if (result.ok) {
        campaign.dialedCount++;
      } else {
        campaign.skippedCount++;
        console.error(`Campaign dial failed for ${to}:`, result.error);
      }
    }

    if (campaign.queue.length === 0 && callsInFlight.size === 0 && campaign.active) {
      campaign.active = false;
      campaign.finishedAt = new Date().toISOString();
      console.log(`Campaign finished: ${campaign.dialedCount} dialed, ${campaign.skippedCount} skipped.`);
    }
  } finally {
    pumpInProgress = false;
    saveCampaignState();
  }
}

setInterval(() => {
  pumpCampaignQueue().catch((err) => console.error('Campaign pump error:', err.message));
}, 15000);

// POST /admin/campaign/start  { includeAlreadyCalled: false }
app.post('/admin/campaign/start', async (req, res) => {
  if (campaign.active) {
    return res.status(409).json({ error: 'a campaign is already running - stop it first' });
  }
  const includeAlreadyCalled = !!req.body?.includeAlreadyCalled;
  const contacts = readContacts();
  const queue = contacts
    .map((c) => c.phone)
    .filter(Boolean)
    .filter((phone) => !isOnDncList(phone))
    .filter((phone) => includeAlreadyCalled || getCallHistoryForNumber(phone).length === 0);

  if (queue.length === 0) {
    return res.status(400).json({ error: 'no eligible contacts to call (empty list, all on DNC, or all already called - try includeAlreadyCalled)' });
  }

  campaign = {
    active: true,
    queue,
    dialedCount: 0,
    skippedCount: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  saveCampaignState();
  pumpCampaignQueue().catch((err) => console.error('Campaign pump error:', err.message));
  res.json({ started: true, queued: queue.length });
});

app.post('/admin/campaign/stop', (req, res) => {
  campaign.active = false;
  campaign.finishedAt = new Date().toISOString();
  saveCampaignState();
  // Calls already in flight are left to finish naturally - this only stops
  // new ones from being dialed off the queue.
  res.json({ stopped: true, remainingInQueue: campaign.queue.length, inFlight: callsInFlight.size });
});

app.get('/admin/campaign/status', (req, res) => {
  res.json({
    active: campaign.active,
    queued: campaign.queue.length,
    inFlight: callsInFlight.size,
    maxConcurrentCalls: appConfig.maxConcurrentCalls,
    dialedCount: campaign.dialedCount,
    skippedCount: campaign.skippedCount,
    startedAt: campaign.startedAt,
    finishedAt: campaign.finishedAt,
  });
});

// ---- Telnyx Call Control webhooks -------------------------------------------
// Telnyx's dial API is asynchronous - unlike Twilio's synchronous /voice
// fetch, everything after the call connects (machine detection result,
// opening the media stream, playing the voicemail clip, hanging up) arrives
// here as a sequence of webhook events instead. Ack every event with 200
// immediately - Telnyx retries on anything else - and do the actual work
// afterward.
app.post('/telnyx/webhook', async (req, res) => {
  if (!verifyTelnyxSignature(req)) {
    console.warn('Rejected /telnyx/webhook: invalid Telnyx signature');
    return res.status(403).send('Invalid signature');
  }
  res.sendStatus(200);

  const eventType = req.body?.data?.event_type;
  const payload = req.body?.data?.payload || {};
  const callControlId = payload.call_control_id;
  if (!callControlId) return;

  try {
    switch (eventType) {
      case 'call.answered':
        // Nothing to do yet - wait for the AMD result below before deciding
        // whether to open the media stream or play the voicemail clip. As a
        // safety net in case AMD never reports back (a Telnyx-side error,
        // or answering_machine_detection getting turned off in a future
        // edit here), fall back to starting the stream after a few seconds.
        pendingTelnyxCalls.set(callControlId, {
          ...(pendingTelnyxCalls.get(callControlId) || {}),
          amdFallbackTimer: setTimeout(() => {
            startTelnyxMediaStream(callControlId).catch((err) =>
              console.error('Telnyx stream start (AMD fallback) failed:', err.message)
            );
          }, 8000),
        });
        break;

      case 'call.machine.premium.detection.ended':
      case 'call.machine.detection.ended': {
        const pending = pendingTelnyxCalls.get(callControlId);
        clearTimeout(pending?.amdFallbackTimer);
        const result = payload.result; // human_residence, human_business, machine, silence, fax_detected, not_sure
        if (result === 'machine' || result === 'fax_detected') {
          logCallEvent({ event: 'voicemail_detected', callSid: callControlId, answeredBy: result });
          await playTelnyxVoicemail(callControlId);
        } else {
          await startTelnyxMediaStream(callControlId);
        }
        break;
      }

      case 'call.playback.ended':
        // Voicemail clip (or its TTS fallback) finished - hang up, same as
        // Twilio's twiml.hangup() right after twiml.play() in /voice.
        await telnyxRequest('POST', `/calls/${callControlId}/actions/hangup`).catch(() => {});
        break;

      case 'call.hangup':
        logCallEvent({
          event: 'status_update',
          callSid: callControlId,
          status: 'completed',
          durationSeconds: payload.call_duration_secs,
        });
        clearTimeout(pendingTelnyxCalls.get(callControlId)?.amdFallbackTimer);
        pendingTelnyxCalls.delete(callControlId);
        activeCallSids.delete(callControlId);
        callsInFlight.delete(callControlId);
        pumpCampaignQueue().catch((err) => console.error('Campaign pump error:', err.message));
        break;
    }
  } catch (err) {
    console.error(`Telnyx webhook handling failed (${eventType}):`, err.message);
  }
});

// Opens the bidirectional media stream to /media-stream for a Telnyx call -
// the Telnyx equivalent of Twilio's <Connect><Stream> in /voice. custom
// parameters carry the callSid/toNumber/company through to CallSession the
// same way Twilio's <Stream> <Parameter> tags do.
async function startTelnyxMediaStream(callControlId) {
  const pending = pendingTelnyxCalls.get(callControlId) || {};
  if (pending.streamed) return; // already started (e.g. AMD result raced the fallback timer)
  pending.streamed = true;
  pendingTelnyxCalls.set(callControlId, pending);

  const toNumber = pending.to || '';
  const contact = readContacts().find((c) => c.phone === toNumber);
  await telnyxRequest('POST', `/calls/${callControlId}/actions/streaming_start`, {
    stream_url: `wss://${PUBLIC_HOSTNAME}/media-stream`,
    stream_track: 'inbound_track',
    stream_bidirectional_mode: 'rtp',
    stream_bidirectional_codec: 'PCMU', // G.711 mu-law - matches our mulaw/8kHz pipeline directly, no transcoding
    stream_bidirectional_sampling_rate: 8000,
    custom_parameters: [
      { name: 'callSid', value: callControlId },
      { name: 'toNumber', value: toNumber },
      { name: 'company', value: contact?.company || '' },
    ],
  });
}

// Telnyx equivalent of the voicemail branch in /voice: play the same
// pre-generated Aura clip, or fall back to Telnyx's own TTS if it's missing.
async function playTelnyxVoicemail(callControlId) {
  if (fsSync.existsSync('./public/voicemail.mp3')) {
    await telnyxRequest('POST', `/calls/${callControlId}/actions/playback_start`, {
      audio_url: `https://${PUBLIC_HOSTNAME}/voicemail.mp3`,
    });
    // hang up is triggered by the call.playback.ended webhook above
  } else {
    await telnyxRequest('POST', `/calls/${callControlId}/actions/speak`, {
      payload: VOICEMAIL_TEXT,
      voice: 'female',
      language: 'en-US',
    });
    // No playback.ended-equivalent guarantee for /speak in every case -
    // hang up after a fixed delay as a fallback instead.
    setTimeout(() => {
      telnyxRequest('POST', `/calls/${callControlId}/actions/hangup`).catch(() => {});
    }, 6000);
  }
}

// ---- Test chat panel: exercise the sales script without touching Twilio ---
// In-memory only - fine for testing script/prompt changes, not meant to
// persist. Same SYSTEM_PROMPT + callLLM the real calls use, so what you see
// here is what the phone agent would actually say.
const testSessions = new Map(); // sessionId -> { history: [{role, content}] }

app.post('/test/start', async (req, res) => {
  const sessionId = req.body.sessionId || 'default';
  const history = [{ role: 'user', content: 'The call just connected. Give your opening line.' }];
  try {
    const reply = await callLLM({ system: systemPrompt, messages: history, maxTokens: 200 });
    history.push({ role: 'assistant', content: reply });
    testSessions.set(sessionId, { history });
    res.json({ sessionId, reply });
  } catch (err) {
    console.error('Test start failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/test/chat', async (req, res) => {
  const sessionId = req.body.sessionId || 'default';
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'missing "message"' });

  const session = testSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'no session - call /test/start first' });

  session.history.push({ role: 'user', content: message });
  try {
    const reply = await callLLM({ system: systemPrompt, messages: session.history, maxTokens: 200 });
    session.history.push({ role: 'assistant', content: reply });
    res.json({ reply, history: session.history });
  } catch (err) {
    console.error('Test chat failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin voice test: record your mic, hear the agent talk back --------
// Same SYSTEM_PROMPT/callLLM/testSessions as the text test panel, but the
// input is real recorded speech (transcribed via Deepgram's prerecorded API)
// and the output is real synthesized audio (Deepgram Aura), so what you hear
// is what a phone call would actually sound like - no Twilio/phone number
// involved, just your browser mic and speakers.

async function transcribeAudio(buffer, mimeType) {
  const res = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': mimeType || 'audio/webm',
      },
      body: buffer,
    }
  );
  if (!res.ok) throw new Error(`Deepgram transcription failed: ${res.status}`);
  const data = await res.json();
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
}

// POST /admin/voice-start { sessionId } -> agent's spoken opening line
app.post('/admin/voice-start', async (req, res) => {
  const sessionId = req.body.sessionId || 'default';
  const history = [{ role: 'user', content: 'The call just connected. Give your opening line.' }];
  try {
    const reply = await callLLM({ system: systemPrompt, messages: history, maxTokens: 200 });
    history.push({ role: 'assistant', content: reply });
    testSessions.set(sessionId, { history });
    const audio = await synthesizeSpeechMp3(reply);
    res.json({ sessionId, reply, audio: audio.toString('base64') });
  } catch (err) {
    console.error('Admin voice start failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/voice-chat?sessionId=... - body is the raw recorded audio blob
// (whatever MediaRecorder produces in the browser, usually audio/webm)
app.post('/admin/voice-chat', express.raw({ type: '*/*', limit: '15mb' }), async (req, res) => {
  const sessionId = req.query.sessionId || 'default';
  const session = testSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'no session - call /admin/voice-start first' });

  try {
    const transcript = await transcribeAudio(req.body, req.headers['content-type']);
    if (!transcript) {
      return res.status(400).json({ error: "couldn't hear anything - try recording again" });
    }

    session.history.push({ role: 'user', content: transcript });
    const reply = await callLLM({ system: systemPrompt, messages: session.history, maxTokens: 200 });
    session.history.push({ role: 'assistant', content: reply });

    const audio = await synthesizeSpeechMp3(reply);
    res.json({ transcript, reply, audio: audio.toString('base64') });
  } catch (err) {
    console.error('Admin voice chat failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Script editor: view/edit the live sales prompt from the admin panel --
// Changes take effect on the next call/test immediately - no redeploy.
app.get('/admin/script', (req, res) => {
  res.json({ prompt: systemPrompt, isDefault: systemPrompt === DEFAULT_SYSTEM_PROMPT });
});

app.post('/admin/script', (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'missing "prompt"' });
  systemPrompt = prompt;
  fsSync.writeFileSync(SCRIPT_PATH, prompt);
  res.sendStatus(204);
});

app.post('/admin/script/reset', (req, res) => {
  systemPrompt = DEFAULT_SYSTEM_PROMPT;
  fsSync.writeFileSync(SCRIPT_PATH, DEFAULT_SYSTEM_PROMPT);
  res.json({ prompt: systemPrompt });
});

// ---- Opening-line template editor -----------------------------------------
// Supports {company} and the optional-block syntax [[...{company}...]] -
// see renderOpeningLine() above. Saving regenerates the cached generic
// (no-company) clip so it stays in sync with the edited template.
app.get('/admin/opening', (req, res) => {
  res.json({ template: openingTemplate, isDefault: openingTemplate === DEFAULT_OPENING_TEMPLATE });
});

app.post('/admin/opening', async (req, res) => {
  const { template } = req.body;
  if (!template || !template.trim()) return res.status(400).json({ error: 'missing "template"' });
  openingTemplate = template;
  fsSync.writeFileSync(OPENING_PATH, template);
  ensureGenericOpeningClip().catch((err) => console.error('Opening clip regeneration failed:', err.message));
  res.sendStatus(204);
});

app.post('/admin/opening/reset', async (req, res) => {
  openingTemplate = DEFAULT_OPENING_TEMPLATE;
  fsSync.writeFileSync(OPENING_PATH, DEFAULT_OPENING_TEMPLATE);
  ensureGenericOpeningClip().catch((err) => console.error('Opening clip regeneration failed:', err.message));
  res.json({ template: openingTemplate });
});

// ---- Live-call TTS provider/model - editable from the admin panel --------
app.get('/admin/tts-config', (req, res) => {
  res.json({ config: ttsConfig, isDefault: JSON.stringify(ttsConfig) === JSON.stringify(DEFAULT_TTS_CONFIG) });
});

app.post('/admin/tts-config', (req, res) => {
  const { provider, model, voice, baseUrl } = req.body;
  if (!provider || !model) return res.status(400).json({ error: 'missing "provider" or "model"' });
  if (provider === 'self_hosted' && !baseUrl) {
    return res.status(400).json({ error: 'self_hosted provider requires a "baseUrl"' });
  }
  ttsConfig = { provider, model, voice: voice || null, baseUrl: baseUrl || null };
  fsSync.writeFileSync(TTS_CONFIG_PATH, JSON.stringify(ttsConfig, null, 2));
  res.sendStatus(204);
});

app.post('/admin/tts-config/reset', (req, res) => {
  ttsConfig = { ...DEFAULT_TTS_CONFIG };
  fsSync.writeFileSync(TTS_CONFIG_PATH, JSON.stringify(ttsConfig, null, 2));
  res.json({ config: ttsConfig });
});

// ---- Operational settings (non-secret) -------------------------------------
// Caller ID, calling hours, concurrency cap, model choices, turn-detection
// timing. Deliberately excludes anything credential-shaped (Account SID,
// Auth Token, API keys) - those stay in env vars since this panel has no
// login yet. Changes apply immediately, no redeploy needed.
app.get('/admin/app-config', (req, res) => {
  res.json({ config: appConfig, isDefault: JSON.stringify(appConfig) === JSON.stringify(DEFAULT_APP_CONFIG) });
});

app.post('/admin/app-config', (req, res) => {
  const { callHoursTz, callHoursStart, callHoursEnd, maxConcurrentCalls, openRouterModel, classifierModel, utteranceEndMs } = req.body;
  const next = {
    callHoursTz: callHoursTz || DEFAULT_APP_CONFIG.callHoursTz,
    callHoursStart: Number.isFinite(+callHoursStart) ? +callHoursStart : DEFAULT_APP_CONFIG.callHoursStart,
    callHoursEnd: Number.isFinite(+callHoursEnd) ? +callHoursEnd : DEFAULT_APP_CONFIG.callHoursEnd,
    maxConcurrentCalls: Number.isFinite(+maxConcurrentCalls) ? +maxConcurrentCalls : DEFAULT_APP_CONFIG.maxConcurrentCalls,
    openRouterModel: openRouterModel || DEFAULT_APP_CONFIG.openRouterModel,
    classifierModel: classifierModel || DEFAULT_APP_CONFIG.classifierModel,
    utteranceEndMs: Number.isFinite(+utteranceEndMs) ? +utteranceEndMs : DEFAULT_APP_CONFIG.utteranceEndMs,
  };
  appConfig = next;
  fsSync.writeFileSync(APP_CONFIG_PATH, JSON.stringify(appConfig, null, 2));
  res.sendStatus(204);
});

app.post('/admin/app-config/reset', (req, res) => {
  appConfig = { ...DEFAULT_APP_CONFIG };
  fsSync.writeFileSync(APP_CONFIG_PATH, JSON.stringify(appConfig, null, 2));
  res.json({ config: appConfig });
});

// ---- Telephony provider + credentials --------------------------------------
// Which service places outbound calls (Twilio or Telnyx) and that
// provider's credentials, editable from Settings > Telephony. Unlike most
// other admin-editable config, this intentionally DOES include secrets
// (Account SID/Auth Token, API key) - GET returns them as-is so the panel
// can populate the form for editing. Same caveat as the rest of this admin
// panel: there's no login yet, so treat this endpoint as effectively public
// until one exists.
app.get('/admin/telephony-config', (req, res) => {
  res.json({ config: telephonyConfig, isDefault: JSON.stringify(telephonyConfig) === JSON.stringify(DEFAULT_TELEPHONY_CONFIG) });
});

app.post('/admin/telephony-config', (req, res) => {
  const {
    provider,
    twilioAccountSid,
    twilioAuthToken,
    twilioPhoneNumber,
    telnyxApiKey,
    telnyxConnectionId,
    telnyxPhoneNumber,
  } = req.body;
  if (provider !== 'twilio' && provider !== 'telnyx') {
    return res.status(400).json({ error: 'provider must be "twilio" or "telnyx"' });
  }
  telephonyConfig = {
    provider,
    twilioAccountSid: twilioAccountSid || '',
    twilioAuthToken: twilioAuthToken || '',
    twilioPhoneNumber: twilioPhoneNumber || '',
    telnyxApiKey: telnyxApiKey || '',
    telnyxConnectionId: telnyxConnectionId || '',
    telnyxPhoneNumber: telnyxPhoneNumber || '',
  };
  fsSync.writeFileSync(TELEPHONY_CONFIG_PATH, JSON.stringify(telephonyConfig, null, 2));
  res.sendStatus(204);
});

app.post('/admin/telephony-config/reset', (req, res) => {
  telephonyConfig = { ...DEFAULT_TELEPHONY_CONFIG };
  fsSync.writeFileSync(TELEPHONY_CONFIG_PATH, JSON.stringify(telephonyConfig, null, 2));
  res.json({ config: telephonyConfig });
});

// ---- Request logs + cost summary ------------------------------------------
// Every STT/LLM/TTS call logs its own latency + estimated cost (see
// logRequestEvent/estimateCost above) - these endpoints surface that data
// for comparing providers/models from real usage instead of price sheets.
// Bulk-test requests are tagged with a distinct source (see the bulk
// testing section) and deliberately excluded here so synthetic test runs
// never inflate real production cost/latency numbers - see
// GET /admin/bulk-test-runs for those instead.
function isRealCallEntry(entry) {
  return !entry.source || entry.source === 'call';
}

app.get('/admin/request-logs', (req, res) => {
  try {
    res.json(readRequestLogs(500).filter(isRealCallEntry));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/cost-summary', (req, res) => {
  try {
    const logs = readAllRequestLogs().filter(isRealCallEntry);
    const summary = {}; // keyed by `${type}:${provider||''}:${model}`
    for (const entry of logs) {
      const key = `${entry.type}:${entry.provider || ''}:${entry.model}`;
      if (!summary[key]) {
        summary[key] = {
          type: entry.type,
          provider: entry.provider || null,
          model: entry.model,
          requests: 0,
          totalCost: 0,
          unknownCostRequests: 0,
          totalDurationMs: 0,
        };
      }
      const s = summary[key];
      s.requests += 1;
      s.totalDurationMs += entry.durationMs || 0;
      if (entry.estimatedCost != null) s.totalCost += entry.estimatedCost;
      else s.unknownCostRequests += 1;
    }
    const rows = Object.values(summary).map((s) => ({
      ...s,
      avgLatencyMs: s.requests ? Math.round(s.totalDurationMs / s.requests) : 0,
    }));
    res.json({
      rows,
      grandTotalCost: rows.reduce((sum, r) => sum + r.totalCost, 0),
      totalRequests: rows.reduce((sum, r) => sum + r.requests, 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Contacts: CSV/XLSX import + list with call history --------------------
// POST /admin/contacts/import - body is the raw file bytes (.csv or .xlsx).
// Expects a header row with at least a phone/number/to column; name/company
// columns are picked up if present. Numbers are used as-is - normalize to
// E.164 in your source file (Twilio will reject anything malformed).
app.post('/admin/contacts/import', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    const filename = (req.query.filename || '').toLowerCase();
    const isCsv = filename.endsWith('.csv') || req.headers['content-type']?.includes('csv');
    const readType = isCsv ? { type: 'buffer', raw: true, codepage: 65001 } : { type: 'buffer', raw: true };
    const workbook = XLSX.read(req.body, readType);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    // raw: false here is what keeps phone numbers as strings ("+15551234567")
    // instead of XLSX auto-converting them to numbers and stripping the "+".
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

    const contacts = rows
      .map((row) => {
        const keys = Object.keys(row);
        const findCol = (candidates) =>
          keys.find((k) => candidates.includes(k.trim().toLowerCase()));
        const phoneKey = findCol(['phone', 'number', 'to', 'phone number', 'mobile']);
        const nameKey = findCol(['name', 'contact', 'contact name']);
        const companyKey = findCol(['company', 'business', 'organization', 'firm']);
        if (!phoneKey || !String(row[phoneKey]).trim()) return null;
        return {
          phone: String(row[phoneKey]).trim(),
          name: nameKey ? String(row[nameKey]).trim() : '',
          company: companyKey ? String(row[companyKey]).trim() : '',
          importedAt: new Date().toISOString(),
        };
      })
      .filter(Boolean);

    if (contacts.length === 0) {
      return res.status(400).json({ error: 'no rows with a recognizable phone/number column found' });
    }

    const result = mergeContacts(contacts);
    res.json(result);
  } catch (err) {
    console.error('Contact import failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/contacts - list, merged with call history (times called, last
// outcome, already-called flag) so the admin panel can show it inline.
app.get('/admin/contacts', (req, res) => {
  const contacts = readContacts();
  const enriched = contacts.map((c) => {
    const history = getCallHistoryForNumber(c.phone);
    const lastCompleted = history.find((h) => h.event === 'stream_ended');
    return {
      ...c,
      timesCalled: history.filter((h) => h.event === 'call_initiated').length,
      lastCalledAt: history[0]?.ts || null,
      lastOutcome: lastCompleted?.outcome || null,
    };
  });
  res.json(enriched);
});

app.delete('/admin/contacts', (req, res) => {
  writeContacts([]);
  res.sendStatus(204);
});

// ---- Analytics ---------------------------------------------------------
app.get('/admin/analytics', (req, res) => {
  const events = readAllCallEvents();
  const initiated = events.filter((e) => e.event === 'call_initiated');
  const completed = events.filter((e) => e.event === 'stream_ended');
  const voicemails = events.filter((e) => e.event === 'voicemail_detected');

  const outcomeCounts = {};
  for (const e of completed) {
    const outcome = e.outcome || 'unclear';
    outcomeCounts[outcome] = (outcomeCounts[outcome] || 0) + 1;
  }

  // Calls initiated per day, last 14 days - enough for a simple trend view.
  const byDay = {};
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    byDay[d.toISOString().slice(0, 10)] = 0;
  }
  for (const e of initiated) {
    const day = e.ts.slice(0, 10);
    if (day in byDay) byDay[day]++;
  }

  res.json({
    totalCallsInitiated: initiated.length,
    totalCompleted: completed.length,
    totalVoicemails: voicemails.length,
    voicemailRate: initiated.length ? voicemails.length / initiated.length : 0,
    dncCount: readDncList().length,
    contactsCount: readContacts().length,
    outcomeCounts,
    callsPerDay: byDay,
  });
});

// ---- Bulk testing: cost/latency comparison without making real calls -----
// Runs canned caller scripts through the exact same production pipeline
// (callLLMStream + fetchLiveSentenceAudio - same functions a live call
// uses) so the cost/latency numbers are real, not simulated. No audio is
// played anywhere (no live call in progress) - a couple of sample clips are
// saved per run so you can still listen for quality. Every request is
// tagged with this run's ID so it never mixes into real-call analytics/cost
// tracking.
const BULK_TEST_SCRIPTS = [
  { name: 'quick_not_interested', turns: ['Hello?', "Not interested, thanks.", "No really, I'm good, please don't call back."] },
  { name: 'full_qualify_to_book', turns: ["This is Dave, what's this about?", 'We just use email for that, why does it matter?', 'Okay, what does it actually do?', 'That sounds useful actually, when could we do a demo?', 'Tuesday afternoon works, use this number.'] },
  { name: 'gatekeeper', turns: ["This is the front desk, she's not in right now.", "I can take a message, what's this regarding?", "I'll pass it along, thanks."] },
  { name: 'pricing_objection', turns: ['How much does this cost?', "That's more than we'd want to spend honestly.", 'Maybe, can you send something in writing?'] },
  { name: 'opt_out', turns: ['Please stop calling me, take me off your list.'] },
];

const BULK_TEST_RUNS_PATH = path.join(DATA_DIR, 'bulk_test_runs.jsonl');
const BULK_TEST_SAMPLES_DIR = path.join('public', 'bulk-test-samples');

function logBulkTestRun(summary) {
  fsSync.appendFileSync(BULK_TEST_RUNS_PATH, JSON.stringify(summary) + '\n');
}

function readBulkTestRuns() {
  if (!fsSync.existsSync(BULK_TEST_RUNS_PATH)) return [];
  const raw = fsSync.readFileSync(BULK_TEST_RUNS_PATH, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).reverse();
}

// Runs one scripted conversation through the real pipeline. `source` tags
// every request this generates so it can be pulled back out of the request
// log afterward for aggregation, and to keep it out of real-call analytics.
async function runBulkTestScript(script, source, saveSample) {
  const history = [];
  const turns = [];
  let sampleSaved = false;

  const opening = renderOpeningLine(openingTemplate, {});
  history.push({ role: 'user', content: 'The call just connected. Give your opening line.' });
  history.push({ role: 'assistant', content: opening });
  const openingAudio = await fetchLiveSentenceAudio(opening, source);
  turns.push({ turn: 'opening', callerLine: null, replyText: opening });
  if (saveSample && !sampleSaved) {
    fsSync.mkdirSync(BULK_TEST_SAMPLES_DIR, { recursive: true });
    fsSync.writeFileSync(path.join(BULK_TEST_SAMPLES_DIR, `${source}.wav`), wrapMulawAsWav(openingAudio));
    sampleSaved = true;
  }

  for (const callerLine of script.turns) {
    history.push({ role: 'user', content: callerLine });

    if (detectOptOutIntent(callerLine)) {
      // Mirrors the real fast path - zero LLM/TTS cost, nothing to log.
      history.push({ role: 'assistant', content: OPT_OUT_CONFIRMATION_TEXT });
      turns.push({ turn: 'opt_out_fastpath', callerLine, replyText: OPT_OUT_CONFIRMATION_TEXT, skippedLLM: true });
      continue;
    }

    let fullReply = '';
    let speakChain = Promise.resolve();
    await callLLMStream({
      system: systemPrompt,
      messages: history,
      maxTokens: 150,
      model: appConfig.openRouterModel,
      source,
      onSentence: (sentence) => {
        fullReply += (fullReply ? ' ' : '') + sentence;
        speakChain = speakChain.then(() => fetchLiveSentenceAudio(sentence, source));
      },
    });
    await speakChain;
    history.push({ role: 'assistant', content: fullReply });
    turns.push({ turn: 'reply', callerLine, replyText: fullReply });
  }

  return { script: script.name, turns };
}

app.post('/admin/bulk-test', async (req, res) => {
  const repeats = Math.min(Math.max(parseInt(req.body.repeats, 10) || 1, 1), 5); // capped - this spends real API cost
  const runId = 'bulktest_' + Date.now();
  const results = [];

  try {
    let scriptIndex = 0;
    for (let i = 0; i < repeats; i++) {
      for (const script of BULK_TEST_SCRIPTS) {
        // Save an audio sample only for the first run through each script,
        // not every repeat - one clip per script is enough to listen to.
        const result = await runBulkTestScript(script, runId, i === 0);
        results.push(result);
        scriptIndex++;
      }
    }

    const logs = readAllRequestLogs().filter((e) => e.source === runId);
    const byType = {};
    let unknownCostRequests = 0;
    for (const e of logs) {
      byType[e.type] = byType[e.type] || { requests: 0, cost: 0 };
      byType[e.type].requests += 1;
      if (e.estimatedCost != null) byType[e.type].cost += e.estimatedCost;
      else unknownCostRequests += 1;
    }
    const totalCost = logs.reduce((sum, e) => sum + (e.estimatedCost || 0), 0);
    const totalRequests = logs.length;
    const avgLatencyMs = totalRequests ? Math.round(logs.reduce((s, e) => s + (e.durationMs || 0), 0) / totalRequests) : 0;

    // Read the actual provider/model back off a logged TTS request rather
    // than snapshotting ttsConfig directly - guarantees this always matches
    // what was really billed, even if the saved config was ever left in an
    // inconsistent state (see fetchLiveSentenceAudio's fallback logic).
    const sampleTtsLog = logs.find((e) => e.type === 'tts');
    const resolvedTts = sampleTtsLog
      ? { provider: sampleTtsLog.provider, model: sampleTtsLog.model }
      : { ...ttsConfig };

    const summary = {
      runId,
      ts: new Date().toISOString(),
      ttsConfig: resolvedTts,
      llmModel: appConfig.openRouterModel,
      scriptsRun: results.length,
      totalCost,
      unknownCostRequests, // if >0, totalCost is a floor, not the real total - some model here isn't in MODEL_PRICING
      totalRequests,
      avgLatencyMs,
      byType,
    };
    logBulkTestRun(summary);
    res.json({ summary, results });
  } catch (err) {
    console.error('Bulk test failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/bulk-test-runs', (req, res) => {
  res.json(readBulkTestRuns());
});

// ---- Do-not-call list -------------------------------------------------------
// POST /dnc { "to": "+15551234567", "reason": "asked to be removed" }
app.post('/dnc', async (req, res) => {
  const { to, reason } = req.body;
  if (!to) return res.status(400).json({ error: 'missing "to" number' });
  await addToDncList(to, reason);
  res.sendStatus(204);
});

app.get('/dnc', (req, res) => {
  res.json(readDncList());
});

// ---- Call status webhook (lifecycle events: ringing, answered, completed) --
const TWILIO_TERMINAL_STATUSES = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];

app.post('/call-status', requireTwilioSignature, (req, res) => {
  const { CallSid, CallStatus, CallDuration, AnsweredBy } = req.body;
  logCallEvent({
    event: 'status_update',
    callSid: CallSid,
    status: CallStatus,
    durationSeconds: CallDuration ? Number(CallDuration) : undefined,
    answeredBy: AnsweredBy,
  });
  if (TWILIO_TERMINAL_STATUSES.includes(CallStatus)) {
    callsInFlight.delete(CallSid);
    pumpCampaignQueue().catch((err) => console.error('Campaign pump error:', err.message));
  }
  res.sendStatus(200);
});

// ---- View logged call events/outcomes --------------------------------------
app.get('/logs', (req, res) => {
  try {
    res.json(readCallEvents(200));
  } catch (err) {
    console.error('Failed to read logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- 2. TwiML: tell Twilio to open a Media Stream to our WS server ---------
app.post('/voice', requireTwilioSignature, (req, res) => {
  const { CallSid, AnsweredBy } = req.body;
  const twiml = new twilio.twiml.VoiceResponse();

  // Voicemail branch: machine detected -> leave a short message and hang up
  // instead of running the full live conversation loop. Uses a pre-generated
  // Aura clip (same voice as the live agent) instead of Twilio's <Say>.
  if (AnsweredBy && AnsweredBy.startsWith('machine')) {
    logCallEvent({ event: 'voicemail_detected', callSid: CallSid, answeredBy: AnsweredBy });
    twiml.pause({ length: 1 }); // let the greeting/beep finish
    if (fsSync.existsSync('./public/voicemail.mp3')) {
      twiml.play(`https://${PUBLIC_HOSTNAME}/voicemail.mp3`);
    } else {
      // Aura clip wasn't generated (missing key, or a transient failure at
      // startup) - fall back so voicemail still works.
      twiml.say({ voice: 'Polly.Joanna' }, VOICEMAIL_TEXT);
    }
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Live call: open the Media Stream, passing CallSid + the callee number
  // through so the WebSocket handler can correlate this session with the
  // log/call record and auto-add to the DNC list on explicit opt-out.
  // company (if this number matches an imported contact) personalizes the
  // skip-LLM opening line - see renderOpeningLine() / handleUserUtterance.
  const toNumber = req.body.To || '';
  const contact = readContacts().find((c) => c.phone === toNumber);
  const connect = twiml.connect();
  const stream = connect.stream({ url: `wss://${PUBLIC_HOSTNAME}/media-stream` });
  stream.parameter({ name: 'callSid', value: CallSid });
  stream.parameter({ name: 'toNumber', value: toNumber });
  stream.parameter({ name: 'company', value: contact?.company || '' });
  res.type('text/xml').send(twiml.toString());
});

// ---- Health check (Railway pings this to confirm the service is up) -------
app.get('/health', (req, res) => res.sendStatus(200));

// ---- 3. HTTP + WS server ----------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (ws) => {
  console.log('Media stream connected');
  new CallSession(ws);
});

const VOICEMAIL_TEXT =
  "Hi, this is PinkTree calling about our tool for visa consultants. " +
  "We'd love to show you a quick demo - call us back or check your email for details.";

// Generate the voicemail clip once at startup (not per-call) so it's a
// single cached mp3 - cheap, and keeps the voice consistent with live calls.
// TODO: re-run this manually (delete public/voicemail.mp3 and restart)
// whenever VOICEMAIL_TEXT or AURA_MODEL changes.
async function ensureVoicemailAudio() {
  const outPath = './public/voicemail.mp3';
  if (fsSync.existsSync(outPath)) return;
  fsSync.mkdirSync('./public', { recursive: true });

  const buffer = await synthesizeSpeechMp3(VOICEMAIL_TEXT);
  fsSync.writeFileSync(outPath, buffer);
  console.log('Generated voicemail.mp3');
}

ensureDataFiles();
loadSystemPrompt();
loadOpeningTemplate();
loadTtsConfig();
loadAppConfig();
loadTelephonyConfig();
loadCampaignState();

// Voicemail audio is a nice-to-have, not core to the service - a bad
// AURA_MODEL or a transient Deepgram error shouldn't crash-loop the whole
// app. Log it and start anyway; the voicemail branch in /voice will just
// skip playback if voicemail.mp3 was never generated.
ensureVoicemailAudio().catch((err) => {
  console.error('Voicemail audio generation failed (continuing without it):', err.message);
});

// Same reasoning as voicemail - backchanneling is a nice-to-have, never
// worth crash-looping the service over.
ensureBackchannelClips().catch((err) => {
  console.error('Backchannel clip generation failed (continuing without it):', err.message);
});

ensureFallbackClips().catch((err) => {
  console.error('Fallback clip generation failed (continuing without it):', err.message);
});

ensureGenericOpeningClip().catch((err) => {
  console.error('Generic opening clip generation failed (falling back to live TTS for it):', err.message);
});

ensureOptOutClip().catch((err) => {
  console.error('Opt-out clip generation failed (fast path disabled, falling back to LLM):', err.message);
});

server.listen(PORT, () => console.log(`Listening on :${PORT}`));

// =============================================================================
// CallSession: one instance per phone call. Owns the Deepgram connection,
// the conversation state, and the Aura TTS streaming, and wires them to the
// telephony provider's Media Stream WebSocket - Twilio or Telnyx, whichever
// placed the call. Both providers speak a near-identical protocol (a
// "start" frame with metadata, then "media" frames of base64 mu-law audio),
// so this class detects which one it's talking to from the shape of the
// "start" frame and adapts the outgoing frame format (sendMedia/sendClear)
// accordingly - everything else (Deepgram, the LLM loop, TTS) is identical
// either way.
// =============================================================================
class CallSession {
  constructor(ws) {
    this.ws = ws;
    this.provider = null; // 'twilio' | 'telnyx' - set once the start frame arrives
    this.streamId = null; // Twilio's streamSid / Telnyx's stream_id
    this.callSid = null; // Twilio's CallSid / Telnyx's call_control_id
    this.history = []; // Anthropic message history: [{role, content}]
    this.speaking = false; // true while our TTS audio is playing out to the caller
    this.finalTranscriptBuffer = '';
    // Set on barge-in - lets a whole turn's queued sentences be cancelled,
    // not just whatever sentence happens to be mid-playback right now.
    this.turnCancelled = false;
    // Set by the opt-out fast path - skips the post-call LLM classifier
    // entirely when the outcome is already certain, saving that call too.
    this.knownOutcome = null;

    this.setupDeepgram();
    this.setupMediaHandlers();
  }

  setupDeepgram() {
    // Streaming STT tuned for phone audio (8kHz mu-law, matches Twilio's format)
    this.dgConnection = deepgram.listen.live({
      model: 'nova-2-phonecall',
      language: 'en-US',
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      smart_format: true,
      interim_results: true,
      endpointing: 300, // ms of silence before Deepgram finalizes each transcript chunk
      vad_events: true, // gives us SpeechStarted events for barge-in
      // utterance_end_ms drives the UtteranceEnd event below, which is a
      // more reliable "the caller is actually done talking" signal than
      // endpointing/speech_final alone - endpointing can fire on a brief
      // mid-thought pause ("I need... to check my calendar") and cut the
      // caller off. UtteranceEnd waits for a longer, more confident gap.
      utterance_end_ms: appConfig.utteranceEndMs,
    });

    this.dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log('Deepgram connection open');
      this.sttStartedAt = Date.now();
    });

    // Barge-in: caller started talking while we're still playing TTS audio.
    // Small debounce (imperceptible to a human, ~150ms) so a brief noise
    // blip - a cough, a stray "uh" - doesn't cut the agent off; a real
    // interruption easily clears this bar.
    this.dgConnection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      if (!this.speaking) return;
      clearTimeout(this.bargeInTimer);
      this.bargeInTimer = setTimeout(() => {
        if (this.speaking) this.interrupt();
      }, 150);
    });

    // Accumulate finalized transcript pieces as they arrive - actual
    // turn-end dispatch happens on UtteranceEnd below, not here.
    this.dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript) return;
      if (data.is_final) {
        this.finalTranscriptBuffer += ` ${transcript}`;
      }
    });

    this.dgConnection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      const utterance = this.finalTranscriptBuffer.trim();
      this.finalTranscriptBuffer = '';
      if (utterance) this.handleUserUtterance(utterance);
    });

    this.dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('Deepgram error:', err);
    });
  }

  setupMediaHandlers() {
    this.ws.on('message', (msg) => {
      const data = JSON.parse(msg);

      switch (data.event) {
        case 'connected':
          // Telnyx-only - first frame on the socket, purely informational.
          break;

        case 'start':
          // Twilio: { start: { streamSid, customParameters: {...} } }
          // Telnyx:  { stream_id, start: { custom_parameters: {...}, call_control_id, to } }
          if (data.start?.streamSid) {
            this.provider = 'twilio';
            this.streamId = data.start.streamSid;
            this.callSid = data.start.customParameters?.callSid || null;
            this.toNumber = data.start.customParameters?.toNumber || null;
            this.contactCompany = data.start.customParameters?.company || '';
          } else {
            this.provider = 'telnyx';
            this.streamId = data.stream_id;
            const params = data.start?.custom_parameters || {};
            this.callSid = params.callSid || data.start?.call_control_id || null;
            this.toNumber = params.toNumber || data.start?.to || null;
            this.contactCompany = params.company || '';
          }
          activeCallSids.add(this.callSid);
          console.log(`Stream started (${this.provider}):`, this.streamId, 'call:', this.callSid);
          logCallEvent({ event: 'stream_started', callSid: this.callSid, streamSid: this.streamId, provider: this.provider });
          // Kick off the conversation with an opening line instead of waiting
          this.handleUserUtterance('[CALL_CONNECTED]');
          break;

        case 'media':
          // Raw mu-law audio chunk from the caller -> feed to Deepgram
          this.dgConnection.send(Buffer.from(data.media.payload, 'base64'));
          break;

        case 'stop':
          console.log('Stream stopped');
          activeCallSids.delete(this.callSid);
          clearTimeout(this.bargeInTimer);
          this.dgConnection.finish();
          this.finalizeCallLog();
          break;
      }
    });

    this.ws.on('close', () => {
      console.log('Media stream WS closed');
      activeCallSids.delete(this.callSid);
      clearTimeout(this.bargeInTimer);
      this.dgConnection.finish();
    });
  }

  // Outgoing audio frame, in whichever shape the connected provider expects.
  // Twilio requires streamSid on every media frame; Telnyx's bidirectional
  // client frames don't carry an id at all (see clientMedia in Telnyx's
  // Media Streaming WebSocket spec).
  sendMedia(payloadBase64) {
    if (this.provider === 'telnyx') {
      this.ws.send(JSON.stringify({ event: 'media', media: { payload: payloadBase64 } }));
    } else {
      this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamId, media: { payload: payloadBase64 } }));
    }
  }

  // Barge-in: stop whatever's queued/playing. Same shape difference as
  // sendMedia above - Telnyx's clear frame has no id, Twilio's needs streamSid.
  sendClear() {
    if (this.provider === 'telnyx') {
      this.ws.send(JSON.stringify({ event: 'clear' }));
    } else {
      this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamId }));
    }
  }

  // Caller finished a turn (or the call just connected) -> ask the LLM what
  // to say, streaming its reply straight into TTS sentence-by-sentence.
  async handleUserUtterance(text) {
    const isOpeningLine = text === '[CALL_CONNECTED]';

    if (isOpeningLine) {
      // The opening line never touches the LLM - it's a fixed template
      // (optionally naming the company), not something generation adds
      // value to, and this is the single most latency-sensitive moment of
      // the call: dead air right after pickup reads as a broken/robotic
      // call. Generic (no company match) uses a clip cached at startup -
      // zero network latency. Personalized (company known) still needs one
      // live TTS call since that text genuinely varies, but skips the LLM
      // round-trip either way.
      this.turnCancelled = false;
      const opening = renderOpeningLine(openingTemplate, { company: this.contactCompany });
      this.history.push({ role: 'user', content: 'The call just connected. Give your opening line.' });
      this.history.push({ role: 'assistant', content: opening });
      if (!this.contactCompany && genericOpeningClip) {
        await this.playBuffer(genericOpeningClip);
      } else {
        await this.speakStreaming(opening);
      }
      return;
    }

    this.history.push({ role: 'user', content: text });
    this.turnCancelled = false; // fresh turn - clear any cancellation from a prior one

    // Fast path: explicit opt-out request. See ensureOptOutClip() for why
    // this skips the LLM/TTS entirely and ends the call right away instead
    // of continuing to run billable minutes on a call that's already over.
    if (detectOptOutIntent(text) && optOutClip) {
      this.history.push({ role: 'assistant', content: OPT_OUT_CONFIRMATION_TEXT });
      this.knownOutcome = 'do_not_call';
      if (this.toNumber) addToDncList(this.toNumber, 'requested removal on call (fast-path match)');
      await this.playBuffer(optOutClip);
      await this.endCall();
      return;
    }

    // Backchanneling: fire a quick "mm-hmm"/"got it" immediately so the
    // caller isn't met with dead air while the LLM generates - masks
    // latency and reads as a natural acknowledgment.
    this.playBackchannel();

    // Sentences play in order via speakChain, but their TTS audio is
    // fetched as soon as the text is ready - not when it's that sentence's
    // turn to play. Without this, sentence 2's TTS generation wouldn't even
    // start until sentence 1 finished playing, adding a dead-air gap
    // between every sentence of a multi-sentence reply. The first sentence
    // still uses true streaming playback (lowest possible time-to-first-
    // audio); sentences after that are prefetched into a buffer in the
    // background while the previous one plays, then played back-to-back.
    let speakChain = Promise.resolve();
    let fullReply = '';
    let sentenceIndex = 0;
    const onSentence = (sentence) => {
      fullReply += (fullReply ? ' ' : '') + sentence;
      const isFirst = sentenceIndex === 0;
      sentenceIndex++;

      if (isFirst) {
        speakChain = speakChain.then(() => {
          if (this.turnCancelled) return;
          return this.speakStreaming(sentence);
        });
      } else {
        // Kick the fetch off now, in parallel with whatever's currently
        // playing - by the time speakChain reaches this sentence, the
        // audio is likely already sitting in memory ready to play.
        const audioPromise = this.fetchSentenceAudio(sentence).catch((err) => {
          console.error('Sentence TTS prefetch failed:', err);
          return null;
        });
        speakChain = speakChain.then(async () => {
          if (this.turnCancelled) return;
          const buffer = await audioPromise;
          if (buffer) await this.playBuffer(buffer);
        });
      }
    };

    try {
      await callLLMStream({
        system: systemPrompt,
        messages: this.history,
        maxTokens: 150,
        onSentence,
      });
      await speakChain;

      if (fullReply) {
        this.history.push({ role: 'assistant', content: fullReply });
      }
      this.consecutiveErrors = 0;
    } catch (err) {
      console.error('LLM error:', err);
      // Don't leave the caller in dead silence - say something and let them
      // continue, rather than the call appearing to have dropped. These use
      // pre-cached audio (no TTS round-trip) since something's already
      // gone wrong and a slow fallback would compound it.
      this.consecutiveErrors = (this.consecutiveErrors || 0) + 1;
      const isRetry = this.consecutiveErrors <= 2;
      const clip = isRetry ? fallbackClips.retry : fallbackClips.giveUp;
      if (clip) {
        await this.playBuffer(clip);
      } else {
        // Pre-cached clip wasn't available (e.g. failed at startup) - fall
        // back to a live TTS call rather than leaving the caller in silence.
        try {
          await this.playBuffer(await this.fetchSentenceAudio(FALLBACK_TEXT[isRetry ? 'retry' : 'giveUp']));
        } catch (ttsErr) {
          console.error('Fallback TTS also failed - caller gets silence:', ttsErr);
        }
      }
    }
  }

  // Play a pre-cached short acknowledgment clip (fire-and-forget, not part
  // of the speakChain) while the real reply is still being generated.
  playBackchannel() {
    if (backchannelClips.length === 0 || this.turnCancelled) return;
    const clip = backchannelClips[Math.floor(Math.random() * backchannelClips.length)];
    this.speaking = true;
    this.sendMedia(clip.toString('base64'));
  }

  // First sentence of a turn: play audio as it streams in from Aura rather
  // than waiting for the whole clip - this is what gives the lowest
  // possible time-to-first-audio for the turn.
  // True low-latency streaming path - only confirmed to work this way for
  // Deepgram Aura (audio starts playing before the full clip is generated).
  // OpenRouter's TTS endpoint hasn't been verified to stream progressively
  // the same way, so when it's selected this falls back to fetch-the-whole-
  // clip-then-play - slightly higher time-to-first-audio on turn 1 only,
  // not a broken call. Sentences after the first already used the buffered
  // path regardless of provider (see fetchSentenceAudio below).
  async speakStreaming(text) {
    if (this.turnCancelled) return;

    if (ttsConfig.provider !== 'deepgram') {
      const buffer = await this.fetchSentenceAudio(text);
      return this.playBuffer(buffer);
    }

    this.speaking = true;
    this.currentUtteranceInterrupted = false;
    const start = Date.now();

    try {
      const res = await fetch(
        `https://api.deepgram.com/v1/speak?model=${AURA_MODEL}&encoding=mulaw&sample_rate=8000&container=none`,
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${DEEPGRAM_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text }),
        }
      );

      for await (const chunk of res.body) {
        if (this.currentUtteranceInterrupted) break; // barge-in cut this off
        this.sendMedia(Buffer.from(chunk).toString('base64'));
      }
      logRequestEvent({
        type: 'tts',
        provider: 'deepgram',
        model: AURA_MODEL,
        source: 'call',
        chars: text.length,
        durationMs: Date.now() - start,
        estimatedCost: estimateCost(AURA_MODEL, { chars: text.length }),
      });
      if (!this.currentUtteranceInterrupted) this.sendPause();
    } catch (err) {
      console.error('TTS error:', err);
    } finally {
      this.speaking = false;
    }
  }

  // Fetches one sentence's full audio into memory without playing it -
  // used to prefetch sentence N+1 while sentence N is still playing, so
  // there's no gap waiting on a fresh TTS round-trip between sentences.
  // Routed through whichever provider is configured (see fetchLiveSentenceAudio).
  async fetchSentenceAudio(text) {
    return fetchLiveSentenceAudio(text);
  }

  // Plays an already-fetched audio buffer (a prefetched sentence, a cached
  // backchannel/fallback clip). Sliced into small frames rather than sent
  // as one giant payload so barge-in can still cut it off promptly mid-clip.
  async playBuffer(buffer) {
    if (this.turnCancelled) return;
    this.speaking = true;
    this.currentUtteranceInterrupted = false;
    const FRAME_BYTES = 320; // 40ms at 8kHz mu-law

    try {
      for (let i = 0; i < buffer.length; i += FRAME_BYTES) {
        if (this.currentUtteranceInterrupted) break;
        const frame = buffer.subarray(i, i + FRAME_BYTES);
        this.sendMedia(frame.toString('base64'));
      }
      if (!this.currentUtteranceInterrupted) this.sendPause();
    } finally {
      this.speaking = false;
    }
  }

  // Natural pause between sentences - G.711 mu-law silence is 0xFF.
  sendPause() {
    const silence = Buffer.alloc(SENTENCE_PAUSE_SAMPLES, 0xff);
    this.sendMedia(silence.toString('base64'));
  }

  // Ends the call immediately via the connected provider's REST API. Used
  // once we're certain there's no reason to keep the line open (opt-out
  // confirmed) - every extra second here is a second of telephony/Deepgram
  // minutes billed on a call that's already resolved.
  async endCall() {
    if (!this.callSid) return;
    try {
      if (this.provider === 'telnyx') {
        await telnyxRequest('POST', `/calls/${this.callSid}/actions/hangup`);
        return;
      }
      await getTwilioClient().calls(this.callSid).update({ status: 'completed' });
    } catch (err) {
      console.error('Failed to end call via REST API:', err.message);
    }
  }

  // Call ended -> ask the classifier model to tag the outcome, then write
  // the full record. Skipped entirely when the outcome is already certain
  // (e.g. the opt-out fast path) - one fewer LLM call on calls where the
  // answer was never in doubt. If the callee explicitly asked not to be
  // called again, auto-add them to the DNC list.
  async finalizeCallLog() {
    let outcome = this.knownOutcome || 'unclear';
    if (!this.knownOutcome && this.history.length > 0) {
      try {
        const transcriptText = this.history
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n');
        const label = await callLLM({
          system:
            'Classify this sales call transcript with exactly one label: ' +
            'booked_demo, interested_followup, not_interested, wrong_person, ' +
            'do_not_call, or unclear. Use do_not_call only if the person ' +
            'explicitly asked to be removed from the calling list or to never ' +
            'be called again - not for an ordinary "not interested".' +
            ' Respond with only the label, nothing else.',
          messages: [{ role: 'user', content: transcriptText }],
          maxTokens: 20,
          model: appConfig.classifierModel, // cheap model - this never talks to the caller
        });
        if (label) outcome = label.trim();

        if (outcome === 'do_not_call' && this.toNumber) {
          await addToDncList(this.toNumber, 'requested removal on call');
        }
      } catch (err) {
        console.error('Outcome classification failed:', err);
      }
    }

    // STT cost approximated from how long the Deepgram connection was open
    // for this call - not exact billed-second precision, but close enough
    // to compare against alternative providers/plans.
    if (this.sttStartedAt) {
      const durationMs = Date.now() - this.sttStartedAt;
      logRequestEvent({
        type: 'stt',
        provider: 'deepgram',
        model: 'nova-2-phonecall',
        source: 'call',
        durationMs,
        estimatedCost: estimateCost('nova-2-phonecall', { durationMs }),
      });
    }

    logCallEvent({
      event: 'stream_ended',
      callSid: this.callSid,
      streamSid: this.streamId,
      outcome,
      transcript: this.history,
    });
  }

  // Caller started talking over the agent -> stop playback immediately and
  // cancel any remaining sentences still queued for this turn.
  interrupt() {
    this.currentUtteranceInterrupted = true;
    this.turnCancelled = true;
    this.sendClear();
  }
}
