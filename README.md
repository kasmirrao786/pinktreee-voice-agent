# AI Voice Calling SaaS — combined platform

Two services, one shared Postgres database. (This was three services
through the initial integration pass — see "Restructuring: three services
down to two" below for what changed and why.)

| Service | Directory | Port | Role |
|---|---|---|---|
| **saas-platform** | `saas-platform/` | 3000 (Next.js default — set `PORT` if it collides) | Customer/admin dashboard. Owns auth, tenants, agent/campaign/lead config UI, **and now the full post-call intelligence pipeline** (summary, sentiment, outcome, lead qualification, appointment booking) as API routes + server actions. **Owns the database schema** (`prisma/schema.prisma`) — the single source of truth calling-engine reads/writes against. |
| **calling-engine** | `calling-engine/` | 3000 | Places/receives calls, runs the AI conversation (STT→LLM→TTS), drives the multi-tenant campaign dialer, ingests knowledge-base sources. Fires a webhook into saas-platform when a call ends. |

## Restructuring: three services down to two

The original 3-way split (calling-engine / saas-platform / intelligence-
service) was a **work-division tool** — three independent build sessions
running in parallel — not a deliberate runtime architecture. Once the code
existed, keeping intelligence-service as its own deployable no longer
bought much: it was a thin request/response service (receive an event,
call an LLM, write rows) already sharing saas-platform's database, paying
full service overhead (its own Dockerfile, `railway.toml`, deploy-order
dependency, duplicated `DATABASE_URL`, a whole separate shared-secret
relationship) for no isolation benefit.

**Folded in:** intelligence-service's logic now lives inside saas-platform
at `src/lib/intelligence/` (call summarization/outcome/sentiment
extraction, lead qualification scoring, appointment booking + calendar
adapters, webhook signature verification, event orchestration), exposed
as:
- `POST /api/webhooks/call-events` — the one genuinely external HTTP
  endpoint, signed and called by calling-engine exactly as before, just at
  a new URL.
- `getAvailableSlotsAction` / `bookAppointmentAction` /
  `cancelAppointmentAction` — server actions, not bare API routes. The
  original design had these as three unauthenticated
  `/tenants/:tenantId/...` HTTP routes callable by anyone who knew a
  tenant ID; as server actions they're scoped to the caller's authenticated
  session instead, which is strictly safer and fits how the rest of the
  dashboard already works.
- The raw-SQL data layer (hand-matching Prisma's schema from the outside)
  is gone for this logic — it now uses the real Prisma client directly.
  This isn't just less code: it's an entire category of bug (the ID-type
  mismatch, the missing-default bug, the stale competing migration — all
  found during the original integration pass) that's now structurally
  impossible rather than merely fixed-for-now, because there's only one
  schema definition in the whole platform instead of one canonical copy
  plus two hand-maintained approximations of it.
- The mock calendar adapter's booked-slots tracking, which used to live in
  an in-process `Map` (fine for a standalone single-replica service, but
  would have silently broken — double-bookings, bookings vanishing on
  restart — the moment saas-platform ran more than one replica, which it's
  explicitly designed to support), now queries real `Appointment` rows via
  Prisma instead. One less piece of hidden state.

**Kept separate:** calling-engine stays its own service, deliberately —
see its `railway.toml` for the reasoning (it holds long-lived per-call
WebSocket connections with real audio-latency budgets; sharing an event
loop with dashboard/LLM-classification traffic is a reliability risk, not
a hypothetical one). It also still can't horizontally scale on its own
(in-process campaign queues) — that's unrelated to the service-count
question and wasn't fixed by this restructuring.

**What this means for you:** `intelligence-service/` no longer exists in
this repo. If you'd already deployed it as its own Railway service,
delete it once saas-platform's merged version is live — leaving both
running would mean calling-engine's webhook only reaches one of them
(whichever `SAAS_PLATFORM_URL`/`INTELLIGENCE_SERVICE_URL` you pointed it
at), silently orphaning the other.

## What changed during platform integration

These three were built as separate sessions against a shared written spec,
not against each other's actual code — the standard risk of that approach
showed up exactly where expected: real schema drift. Fixed during
integration:

- **ID type mismatch** — saas-platform's Prisma schema uses `TEXT`/cuid
  primary keys; calling-engine had built its own schema using Postgres
  native `UUID` columns. Resolved by making Prisma's schema the one
  canonical source (`saas-platform/prisma/schema.prisma`) and rewriting
  calling-engine's `db/index.js` to stop running its own competing
  `CREATE TABLE` statements. (This entry originally said calling-engine
  "now only owns `dnc_numbers`" — that turned out to be only half true;
  see the dedicated entry below for the rest of that story.)
- **Credential storage split** — calling-engine had designed per-phone-
  number credentials; saas-platform built per-(tenant, provider) shared
  credentials with its own AES-256-GCM encryption. Resolved by having
  calling-engine read from saas-platform's `provider_credentials` table
  using the *identical* encryption packing format (see
  `calling-engine/db/index.js` `encryptCredential`/`decryptCredential` vs.
  `saas-platform/src/lib/crypto.ts`) — either service can decrypt what the
  other wrote.
- **`transfer_conditions` shape mismatch** — calling-engine used
  `{type, value}` objects; saas-platform's UI built a plain string array.
  Standardized on the simpler string array.
- **`outcome` vocabulary drift** — three different projects, three
  different implicit outcome taxonomies (calling-engine's classifier,
  intelligence-service's classifier, saas-platform's seed data). Resolved
  by removing calling-engine's own full-transcript outcome-classification
  LLM call entirely — that's intelligence-service's job now, and only its
  vocabulary is authoritative. Calling-engine keeps a synchronous,
  deterministic DNC-phrase check (not a full classification) so opt-out
  compliance doesn't have to wait on the async pipeline.
- **Field naming** — `opening_line_template` → `greeting_message`
  throughout, to match the shared schema.
- **`dnc_numbers` had two competing owners, undetected until this
  restructuring pass.** A `DncNumber` Prisma model was added to the
  canonical schema during the original integration (to keep a single
  source of truth), but calling-engine's own `db/dnc_schema.sql` — written
  under the original "dnc_numbers is the one table calling-engine
  exclusively owns" assumption — never got removed, and kept creating the
  same table with a slightly different column type (`TIMESTAMPTZ` vs.
  Prisma's `TIMESTAMP(3)`). Harmless only because saas-platform always
  deployed first in every environment this was tested in (`IF NOT EXISTS`
  made calling-engine's version a silent no-op) — but a real drift risk
  the moment deploy order was ever violated. Found by grepping the schema
  for duplicate `@@map` table names while restructuring, not by anything
  failing at runtime — exactly the kind of thing that's invisible until a
  deploy happens in the "wrong" order. Fixed: calling-engine's competing
  migration is deleted; `migrate()` is now an honest no-op with a comment
  explaining why; verified live against a real Postgres instance
  afterward (fresh schema push, then calling-engine's DNC read/write
  functions exercised against it directly).
- **Multi-tenant campaign dialer added** — calling-engine's campaign queue
  was single-tenant/in-memory and had no concept of Project 2's
  `campaigns`/`leads` tables at all. Added tenant-scoped
  `/tenants/:tenantId/campaigns/:campaignId/{start,pause,stop,status}`
  routes that load real leads/agent/credentials from the shared DB and
  dial through the same underlying call-placement code the single-tenant
  admin panel already used (refactored to accept optional per-campaign
  context rather than duplicated). saas-platform's `startCampaignAction`/
  `pauseCampaignAction`/`stopCampaignAction` now call these instead of
  only flipping a status field.
- **Knowledge-base ingestion endpoint added** — saas-platform's
  `knowledge.ts` already POSTed `{sourceId, tenantId, agentId}` to
  `INGESTION_ENDPOINT_URL` expecting calling-engine to chunk, embed, and
  store the result; that endpoint didn't exist yet. Added `POST /ingest`
  (chunking + pgvector storage; embedding generation calls out to a
  self-hosted OpenAI-compatible embeddings server — see "not wired" below).
- **calling-engine → intelligence-service webhook added** — calling-engine
  previously only logged call outcomes to a flat file. It now fires a
  signed `call.ended` webhook after every call, and no longer runs its own
  redundant full-transcript outcome classification (see the "outcome
  vocabulary drift" point above).
- **`transfer_triggered`/`transfer_reason` were dead columns** — the
  schema had them, saas-platform's call-detail UI already had a
  "Transferred — {reason}" display built for them, but nothing in
  calling-engine ever wrote to them. `performTransfer()` only set a
  transient in-memory outcome that intelligence-service's async
  classifier would silently overwrite a few seconds later (its
  vocabulary has no "transferred" category) - so the signal that a
  human took over a call was being lost entirely. Fixed:
  `performTransfer()` now writes both columns directly, which
  intelligence-service's classifier never touches. Found by auditing
  against the original feature spec's "Human Call Transfer" section, not
  by running anything - then verified live against real Postgres.

See each service's own README for what's real/tested vs. stubbed within
that service specifically.

## Known gap: Prisma CLI couldn't be exercised during this integration

`prisma generate` / `db push` / `migrate` need to download engine binaries
from `binaries.prisma.sh`. That wasn't reachable from the sandbox this
integration was built in, so:

- `saas-platform/prisma/sandbox-snapshot.sql` is a hand-translated,
  by-hand copy of the schema, used only to prove the integration against a
  real Postgres instance in that sandbox. **Ignore it in your own
  environment** — run the real `npm run db:push` there, it should work
  normally.
- saas-platform's TypeScript build/typecheck could not be verified in that
  sandbox either (same blocker — `prisma generate` produces the typed
  client the app imports). Run `npm run build` yourself before deploying;
  if anything doesn't compile against the schema changes listed above,
  that's the first place to look.

## Audit against the original feature spec

Going back through the original 26-section feature scope document
category by category, against what's actually in the three codebases
today:

**Built and wired:**
User accounts/auth/multi-tenancy, roles & team invites, SaaS usage
dashboard (calls/minutes/campaigns/agents/agent-usage/recent-calls), agent
CRUD with system prompt/voice/greeting/closing/transfer config, knowledge
base per agent (upload/list/delete UI + real chunk-embed-retrieve pipeline
behind it), multi-provider telephony architecture (Twilio + Telnyx behind
one interface, credentials per tenant), inbound + outbound calling, human
call transfer (now actually signals correctly - see fix above), lead
management (CRUD/CSV import/status/tags/notes/call history), campaigns
(create/start/pause/stop/monitor, real multi-tenant dialer behind it), call
recording/transcript/summary/outcome/sentiment, call intelligence
(summarization, sentiment, intent, objections, questions, follow-up flag,
budget/requirements/timeline extraction), lead qualification
(score/label), appointment booking (calendar-provider abstraction,
mock + Google adapters, auto-booking), super admin panel (tenant list,
activate/deactivate, audit log, platform settings), security/tenant
isolation, DNC compliance.

**Built but genuinely worth flagging as thin, not absent:**
- "Analytics & Reporting" / "Campaign Analytics" / "AI Agent Analytics"
  (spec sections 16-18) — the dashboard and campaign-detail page show
  *some* numbers (totals, dialed/skipped counts, agent call-volume
  ranking), but there's no conversion-rate calculation, no outcome-
  breakdown chart, no date-range filtering, no exportable data, and no
  agent-level qualification/transfer/appointment-rate metrics anywhere.
  This is the single biggest gap between what the dashboard shows today
  and what the spec asked for.
- "Appointment Booking" mid-call slot offering — implemented as post-call
  only (already flagged); live in-call offering was an explicit
  build-note trade-off, not an oversight.

**Not built at all:**
- **Branding & Customization** (spec section 20) — no logo upload, brand
  colors, custom login/dashboard branding, or custom domain support
  anywhere in saas-platform. Zero code toward this.
- **Automated Workflows** (spec section 13, trigger→action system) — no
  workflow engine exists. Project 3's scope was narrowed to call
  intelligence + appointment booking specifically during the 3-way
  project split; workflow automation was cut from that scope and never
  came back.
- **Follow-Up Automation** (spec section 14: auto-retry, scheduled
  callbacks, outcome/status-based branching, dedup) — same story, cut at
  the same point, never built.
- **CRM & External Integrations** (spec section 15: webhooks, REST API
  for external systems) — saas-platform's `/api` routes are internal only
  (auth, health, knowledge-file upload). Nothing lets an external CRM
  push or pull lead/call/appointment data. Intelligence-service's build
  notes flagged this as scoped-out too.
- **Notifications** (spec section 25: call-completed, lead-qualified,
  appointment-booked, campaign-status, transfer, system/error, with
  configurable destinations) — zero notification system anywhere. The
  closest thing that exists is intelligence-service's appointment-
  confirmation stub, which logs and marks a DB flag but doesn't actually
  send anything (already flagged in its own README).
- **Self-hosted STT** — flagged repeatedly already; still Deepgram-only.

**Net assessment:** the *call-handling and data* spine of the platform —
telephony, conversation, campaigns, leads, intelligence, appointments,
tenancy, admin — is real and has been exercised end to end against actual
Postgres in this sandbox. The *business-operations layer* on top of that
spine — analytics depth, workflow/follow-up automation, external
integrations, notifications, white-labeling — is mostly not built. None of
that is subtle or hidden: it's four entire feature-spec sections with no
code behind them at all, plus a fifth (analytics) that exists only at a
surface level. Worth deciding explicitly whether those are in scope for a
next pass, given the $400/4-week proposal this was originally scoped
against almost certainly didn't budget for all of them either.

## Running both services together (local dev)

```bash
# 1. One shared Postgres. If pgvector isn't already available:
#    apt install postgresql-16-pgvector  (or your distro's equivalent)
createdb pinktree_voice_saas

# 2. Schema — saas-platform is the migration authority, run this FIRST
cd saas-platform
cp .env.example .env        # fill in DATABASE_URL (same DB for calling-engine below), CALL_EVENTS_WEBHOOK_SECRET, OPENROUTER_API_KEY, etc.
npm install
npm run db:push             # creates every shared table, including the tables intelligence-service used to own
npm run dev                 # http://localhost:3000 (or your configured PORT)

# 3. calling-engine — same DATABASE_URL, plus its own additive table
cd ../calling-engine
cp .env.example .env        # DATABASE_URL = same as above; CREDENTIAL_ENCRYPTION_KEY = same as saas-platform's; SAAS_PLATFORM_URL = http://localhost:3000
npm install
node db/migrate.js          # no-op now - every table this service uses, including dnc_numbers, comes from step 2
npm start                   # http://localhost:3000 -> change PORT in .env if it collides with saas-platform
```

Two env values must be **byte-for-byte identical** across the two services
or things will fail in ways that look unrelated to config:
- `CREDENTIAL_ENCRYPTION_KEY` — saas-platform and calling-engine (credential
  encryption/decryption)
- `CALL_EVENTS_WEBHOOK_SECRET` — saas-platform and calling-engine (webhook
  signing/verification — this used to be shared between calling-engine and
  the standalone intelligence-service; same secret, same purpose, just
  saas-platform is the one verifying it now)

(`DATABASE_URL` obviously needs to point both services at the same
database too, but the connection *string* itself can differ — e.g.
internal Docker hostnames vs. `localhost` — so it's not a byte-for-byte
requirement the way the two secrets above are.)

## What's still not wired (honest list, not swept under the rug)

- **`EMBEDDING_SERVICE_URL` has no server behind it yet** in either repo,
  but the full pipeline behind it was verified this round using a small
  local mock OpenAI-compatible embeddings server (hash-based fake vectors,
  only to prove the plumbing): `/ingest` correctly rejects with a clear
  error when unconfigured, and with the mock server in place, chunking →
  pgvector storage → cosine-similarity retrieval via `searchKnowledgeChunks`
  all work end to end, with source content integrity preserved through the
  whole pipeline. Point `EMBEDDING_SERVICE_URL` at a real embeddings server
  (text-embeddings-inference, LocalAI, Ollama) for actual semantic quality
  — the mechanics are proven, the fake vectors obviously aren't
  semantically meaningful.
- **`/voice`'s campaign-context lookup** (the new `pendingOutboundCalls`
  consumption for campaign-originated calls) could not be fully exercised
  — it's only populated after a real Twilio dial succeeds, which this
  sandbox can't reach. Its fallback path (used by the existing
  single-tenant admin panel today, and by any call where the lookup
  misses) was verified live and returns correct TwiML.
- **Self-hosted STT** was flagged as a decision in an earlier round but
  never actually implemented — calling-engine's live STT is still
  Deepgram-only. Swapping real-time streaming STT is a materially riskier
  change (audio-timing sensitive) than the TTS swap was, and wasn't
  attempted here.
- **The full webhook chain has been verified up to, but not including, the
  live LLM call.** A real end-to-end test was run: seeded a tenant/agent/
  lead/call in the shared DB, sent the exact signed `call.ended` webhook
  calling-engine's `webhooks.js` produces, and confirmed intelligence-
  service received it, verified the signature, and correctly looked up
  the call/lead/tenant rows. It failed at the OpenRouter API call only
  because this sandbox's network egress doesn't allow `openrouter.ai` —
  with a real API key and network access that step should complete; it's
  independently unit-tested already (with a mocked LLM response) in
  intelligence-service's own test suite.
  - **This test caught two real bugs**, both now fixed: intelligence-
    service's own migration was still creating its old UUID-typed copies
    of `tenants`/`leads`/`calls`/`appointments` (harmless only because
    saas-platform's tables already existed by the time it ran — would
    have created an incompatible schema if run first); and
    `appointmentService.js` was relying on a database-level `id` default
    that no longer exists under the canonical TEXT/cuid schema. Both are
    fixed now, but worth noting *how* they were found — by actually
    running the code, not by reading it.
- **Campaign engine**: implemented, wired, and now genuinely tested against
  a real (seeded) campaign — booted calling-engine against the shared DB,
  saved real-shaped (fake-valued) Twilio credentials through the actual
  encrypt/decrypt path, seeded a campaign with 3 leads (one deliberately
  missing a phone number), and hit `/start`. Verified: credential
  round-trip through AES-256-GCM works, the no-credentials-yet case fails
  with a clear error instead of a crash, the no-phone lead is correctly
  skipped, the queue drains completely, concurrency tracking behaves, the
  campaign status correctly flips `draft → running → completed`, and a
  failed dial (this sandbox can't reach `api.twilio.com`) is caught and
  counted as skipped rather than crashing the pump loop — and, correctly,
  leaves no orphaned `calls` row behind for a call that was never actually
  placed. Only the real provider network call itself couldn't be
  exercised. This test caught one more bug (below).
  - **Bug found and fixed**: the `/start` response's `queued` count was
    briefly wrong (a fire-and-forget `pumpCampaign()` call could shift an
    item off the shared queue array before the response read its length —
    a classic shared-mutable-state race). Didn't affect which leads
    actually got dialed, only the immediately-returned count. Fixed by
    capturing the count before the async pump starts draining it.
- **Appointment booking's live-vs-post-call decision** is still post-call
  auto-booking, not live in-call slot offering (unchanged by the
  restructuring — this was a build-note trade-off, not an artifact of
  which service the code lived in) — calling-engine doesn't call the
  availability lookup mid-conversation.
- **The intelligence pipeline's port into saas-platform (Prisma, TypeScript,
  server actions) could not be executed in this sandbox** — same
  `binaries.prisma.sh` blocker as saas-platform's build generally, but now
  also blocking this specific new code, since `@prisma/client`'s
  TypeScript types don't exist until `prisma generate` runs, and
  everything in `src/lib/intelligence/` past the pure-logic modules
  depends on those types. What WAS run: the three pure-logic test files
  (`qualification.test.ts`, `callIntelligence.test.ts`,
  `verifyWebhook.test.ts` — 14 tests, all passing, ported near-verbatim
  from the standalone service's already-verified versions) work fine
  standalone since they don't touch Prisma. The integration test
  (`eventHandler.integration.test.ts`) is written and ready but genuinely
  unexecuted — it's the direct TypeScript/Prisma port of the test that
  DID pass against real Postgres when this logic still lived in the
  standalone intelligence-service (see the entries below this one for
  that evidence) — reasonable confidence the logic itself carried over
  correctly given how mechanical the port was, but "the old version
  passed" and "this version passes" are different claims, and only the
  first one is backed by an actual test run right now. Run `npm test`
  yourself once `prisma generate` succeeds to close this gap for real.
- **Everything below this point describes the pre-restructuring
  architecture** (calling-engine → standalone intelligence-service) —
  preserved as the evidence trail for what was actually tested, since the
  underlying logic carried over into saas-platform largely unchanged. Read
  "intelligence-service" in the entries below as "the code now living at
  saas-platform's `src/lib/intelligence/`."
- **No automated test proves the three services' schemas match** beyond
  this integration pass — if any of the three is modified independently
  again later, the same drift can reappear (as the two bugs above
  demonstrate happening even within this same integration pass, the
  moment something touched the schema). Worth a periodic cross-check (or,
  better, generating calling-engine's/intelligence-service's
  expected-column lists from `schema.prisma` directly instead of
  hand-maintaining them) if this becomes a recurring pattern.
- **saas-platform's TypeScript build is still unverified** — same Prisma
  binary blocker as before (checked whether `@prisma/engines` could be
  installed from the npm registry instead of `binaries.prisma.sh` — it
  still shells out to the same blocked download under the hood, so no
  workaround was available in this sandbox). Run `npm run build` yourself;
  the `campaigns.ts` changes in this round are small and typed against
  existing patterns in that file, but haven't been compiled.
- **calling-engine was booted for real against the shared DB** in this
  round (not just syntax-checked) — confirmed the bootstrap tenant/agent
  creation works against the canonical schema, `/health` responds, and the
  campaign flow above was verified live. TTS pre-generation warnings in
  the boot log are expected with a fake Deepgram key, not a bug.
