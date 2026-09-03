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

// ---- File-based storage on a Railway Volume --------------------------------
// Set DATA_DIR to your Railway volume's mount path (e.g. /data) in production
// so this survives restarts/redeploys. Falls back to ./data for local dev.
//   call_events.jsonl  - append-only log of every call event
//   dnc_numbers.json   - JSON array of do-not-call entries
//   contacts.json      - JSON array of imported contacts (CSV/XLSX)
//   system_prompt.txt  - the live sales script, editable from the admin panel
const DATA_DIR = process.env.DATA_DIR || './data';
const CALL_EVENTS_PATH = path.join(DATA_DIR, 'call_events.jsonl');
const DNC_PATH = path.join(DATA_DIR, 'dnc_numbers.json');
const CONTACTS_PATH = path.join(DATA_DIR, 'contacts.json');
const SCRIPT_PATH = path.join(DATA_DIR, 'system_prompt.txt');

function ensureDataFiles() {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
  if (!fsSync.existsSync(CALL_EVENTS_PATH)) fsSync.writeFileSync(CALL_EVENTS_PATH, '');
  if (!fsSync.existsSync(DNC_PATH)) fsSync.writeFileSync(DNC_PATH, '[]');
  if (!fsSync.existsSync(CONTACTS_PATH)) fsSync.writeFileSync(CONTACTS_PATH, '[]');
  // system_prompt.txt is seeded from DEFAULT_SYSTEM_PROMPT further down,
  // once that constant exists - see loadSystemPrompt().
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
  DEEPGRAM_API_KEY,
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5',
  AURA_MODEL = 'aura-asteria-en', // Deepgram TTS voice - see deepgram.com/docs for the full list
  PORT = 3000,
  PUBLIC_HOSTNAME,
  // Compliance / rate-limiting knobs - tune per the market you're calling into.
  CALL_HOURS_TZ = 'America/New_York',
  CALL_HOURS_START = '9',  // 24h, local to CALL_HOURS_TZ
  CALL_HOURS_END = '20',   // 24h, local to CALL_HOURS_TZ
  MAX_CONCURRENT_CALLS = '5',
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const deepgram = createDeepgramClient(DEEPGRAM_API_KEY);

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

// ---- LLM brain, via OpenRouter (OpenAI-compatible chat completions) -------
// Used both by live calls and the no-Twilio /test chat panel below.
async function callLLM({ system, messages, maxTokens = 200 }) {
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
      model: OPENROUTER_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// Tracks calls currently in the live Media Stream loop, so /call can refuse
// new dials once at capacity instead of overwhelming the STT/LLM/TTS APIs.
const activeCallSids = new Set();

// TODO: replace with a real per-region calling-hours check if you operate
// across timezones tied to the callee's location rather than a single one.
function isWithinCallingHours() {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: CALL_HOURS_TZ,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  const hour = parseInt(hourStr, 10);
  return hour >= parseInt(CALL_HOURS_START, 10) && hour < parseInt(CALL_HOURS_END, 10);
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
  if (fsSync.existsSync(SCRIPT_PATH)) {
    systemPrompt = fsSync.readFileSync(SCRIPT_PATH, 'utf-8');
  } else {
    fsSync.writeFileSync(SCRIPT_PATH, DEFAULT_SYSTEM_PROMPT);
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

// ---- 1. Outbound call trigger ----------------------------------------------
// POST /call  { "to": "+15551234567", "forceCall": false }
app.post('/call', async (req, res) => {
  const { to, forceCall } = req.body;
  if (!to) return res.status(400).json({ error: 'missing "to" number' });

  if (await isOnDncList(to)) {
    return res.status(403).json({ error: 'number is on the do-not-call list' });
  }
  if (!isWithinCallingHours()) {
    return res.status(403).json({
      error: `outside allowed calling hours (${CALL_HOURS_START}:00-${CALL_HOURS_END}:00 ${CALL_HOURS_TZ})`,
    });
  }
  if (activeCallSids.size >= parseInt(MAX_CONCURRENT_CALLS, 10)) {
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

  try {
    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      url: `https://${PUBLIC_HOSTNAME}/voice`, // Twilio fetches TwiML from here once answered
      // Synchronous machine detection: Twilio delays connecting the call
      // until it decides human vs. machine, then passes AnsweredBy to /voice.
      machineDetection: 'DetectMessageEnd',
      machineDetectionTimeout: 15,
      statusCallback: `https://${PUBLIC_HOSTNAME}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });
    logCallEvent({ event: 'call_initiated', callSid: call.sid, to });
    res.json({ sid: call.sid, status: call.status });
  } catch (err) {
    console.error('Call creation failed:', err);
    res.status(500).json({ error: err.message });
  }
});

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
app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus, CallDuration, AnsweredBy } = req.body;
  logCallEvent({
    event: 'status_update',
    callSid: CallSid,
    status: CallStatus,
    durationSeconds: CallDuration ? Number(CallDuration) : undefined,
    answeredBy: AnsweredBy,
  });
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
app.post('/voice', (req, res) => {
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
  const connect = twiml.connect();
  const stream = connect.stream({ url: `wss://${PUBLIC_HOSTNAME}/media-stream` });
  stream.parameter({ name: 'callSid', value: CallSid });
  stream.parameter({ name: 'toNumber', value: req.body.To || '' });
  res.type('text/xml').send(twiml.toString());
});

// ---- Health check (Railway pings this to confirm the service is up) -------
app.get('/health', (req, res) => res.sendStatus(200));

// ---- 3. HTTP + WS server ----------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (twilioWs) => {
  console.log('Twilio media stream connected');
  new CallSession(twilioWs);
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

// Voicemail audio is a nice-to-have, not core to the service - a bad
// AURA_MODEL or a transient Deepgram error shouldn't crash-loop the whole
// app. Log it and start anyway; the voicemail branch in /voice will just
// skip playback if voicemail.mp3 was never generated.
ensureVoicemailAudio().catch((err) => {
  console.error('Voicemail audio generation failed (continuing without it):', err.message);
});

server.listen(PORT, () => console.log(`Listening on :${PORT}`));

// =============================================================================
// CallSession: one instance per phone call. Owns the Deepgram connection,
// the conversation state, and the Aura TTS streaming, and wires them to the
// Twilio Media Stream WebSocket.
// =============================================================================
class CallSession {
  constructor(twilioWs) {
    this.twilioWs = twilioWs;
    this.streamSid = null;
    this.callSid = null;
    this.history = []; // Anthropic message history: [{role, content}]
    this.speaking = false; // true while our TTS audio is playing out to the caller
    this.finalTranscriptBuffer = '';

    this.setupDeepgram();
    this.setupTwilioHandlers();
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
      endpointing: 300, // ms of silence before a final transcript is emitted
      vad_events: true, // gives us SpeechStarted events for barge-in
    });

    this.dgConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log('Deepgram connection open');
    });

    // Barge-in: caller started talking while we're still playing TTS audio
    this.dgConnection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      if (this.speaking) this.interrupt();
    });

    this.dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript) return;

      if (data.is_final) {
        this.finalTranscriptBuffer += ` ${transcript}`;
        if (data.speech_final) {
          const utterance = this.finalTranscriptBuffer.trim();
          this.finalTranscriptBuffer = '';
          if (utterance) this.handleUserUtterance(utterance);
        }
      }
    });

    this.dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('Deepgram error:', err);
    });
  }

  setupTwilioHandlers() {
    this.twilioWs.on('message', (msg) => {
      const data = JSON.parse(msg);

      switch (data.event) {
        case 'start':
          this.streamSid = data.start.streamSid;
          this.callSid = data.start.customParameters?.callSid || null;
          this.toNumber = data.start.customParameters?.toNumber || null;
          activeCallSids.add(this.callSid);
          console.log('Stream started:', this.streamSid, 'call:', this.callSid);
          logCallEvent({ event: 'stream_started', callSid: this.callSid, streamSid: this.streamSid });
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
          this.dgConnection.finish();
          this.finalizeCallLog();
          break;
      }
    });

    this.twilioWs.on('close', () => {
      console.log('Twilio WS closed');
      activeCallSids.delete(this.callSid);
      this.dgConnection.finish();
    });
  }

  // Caller finished a turn (or the call just connected) -> ask Claude what to say
  async handleUserUtterance(text) {
    const userMessage =
      text === '[CALL_CONNECTED]'
        ? 'The call just connected. Give your opening line.'
        : text;

    this.history.push({ role: 'user', content: userMessage });

    try {
      const replyText = await callLLM({
        system: systemPrompt,
        messages: this.history,
        maxTokens: 200,
      });

      this.history.push({ role: 'assistant', content: replyText });
      this.consecutiveErrors = 0;
      await this.speak(replyText);
    } catch (err) {
      console.error('LLM error:', err);
      // Don't leave the caller in dead silence - say something and let them
      // continue, rather than the call appearing to have dropped.
      this.consecutiveErrors = (this.consecutiveErrors || 0) + 1;
      if (this.consecutiveErrors <= 2) {
        await this.speak("Sorry, I didn't quite catch that - could you say that again?");
      } else {
        // Repeated failures - end gracefully instead of looping forever.
        await this.speak('Sorry, I\'m having trouble with the line. I\'ll follow up by email instead. Thanks for your time.');
      }
    }
  }

  // Stream Deepgram Aura TTS audio (mu-law 8kHz, matches Twilio directly) to the caller
  async speak(text) {
    this.speaking = true;
    this.currentUtteranceInterrupted = false;

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
        this.twilioWs.send(
          JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: { payload: Buffer.from(chunk).toString('base64') },
          })
        );
      }
    } catch (err) {
      console.error('TTS error:', err);
    } finally {
      this.speaking = false;
    }
  }

  // Call ended -> ask Claude to tag the outcome, then write the full record.
  // One extra cheap call per finished call; keeps outcome tagging consistent
  // instead of hand-parsing transcripts later. If the callee explicitly asked
  // not to be called again, auto-add them to the DNC list.
  async finalizeCallLog() {
    let outcome = 'unclear';
    if (this.history.length > 0) {
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
        });
        if (label) outcome = label.trim();

        if (outcome === 'do_not_call' && this.toNumber) {
          await addToDncList(this.toNumber, 'requested removal on call');
        }
      } catch (err) {
        console.error('Outcome classification failed:', err);
      }
    }

    logCallEvent({
      event: 'stream_ended',
      callSid: this.callSid,
      streamSid: this.streamSid,
      outcome,
      transcript: this.history,
    });
  }

  // Caller started talking over the agent -> stop playback immediately
  interrupt() {
    this.currentUtteranceInterrupted = true;
    this.twilioWs.send(
      JSON.stringify({ event: 'clear', streamSid: this.streamSid })
    );
  }
}
