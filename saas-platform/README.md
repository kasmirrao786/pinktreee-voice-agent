# PinkTree — SaaS Platform (+ call intelligence pipeline)

Everything a customer or platform admin clicks through: auth, dashboards,
agent/knowledge-base/lead/campaign management, call results, and the
platform admin panel. Built standalone against a shared Postgres database —
Projects 1 (calling engine) and 3 (summarization/qualification) read and
write the same tables directly; there is no REST API between the three
tracks, just the shared schema in `prisma/schema.prisma`.

## Stack
- **Next.js 14** (App Router) + TypeScript, React Server Components + Server
  Actions (minimal client JS — most of the UI needs no API routes).
- **Prisma + Postgres** — schema matches the shared data contract exactly
  (table/column names preserved via `@map`, do not rename).
- **iron-session** for signed, httpOnly cookie sessions.
- **Tailwind CSS** for styling.
- **bcryptjs** for password hashing, Node's built-in `crypto` for AES-256-GCM
  credential encryption (no extra crypto dependency).

## Getting started
```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, SESSION_SECRET, CREDENTIAL_ENCRYPTION_KEY

# generate SESSION_SECRET and CREDENTIAL_ENCRYPTION_KEY:
openssl rand -base64 32

# enable pgvector before the first push (see prisma/sql/enable-pgvector.sql)
psql "$DATABASE_URL" -f prisma/sql/enable-pgvector.sql

npm run db:push      # creates tables from schema.prisma
npm run db:seed      # fixture tenant, agent, leads, campaign, calls
npm run dev
```

Seeded logins:
- Customer (owner): `demo@acme.test` / `changeme123`
- Customer (member): `teammate@acme.test` / `changeme123`
- Platform admin: `admin@pinktreee.com` / `changeme123`

## How the tenant-scoping guarantee works
Every authenticated page/action goes through **one** function —
`requireSession()` in `src/lib/session.ts` — to get `tenantId` from the
signed session cookie. Every Prisma query in the app filters by that
`tenantId`, and every mutation uses `updateMany`/`deleteMany` with `tenantId`
in the `where` clause (not just `id`), so a tampered or guessed record id can
never touch another tenant's row. `src/middleware.ts` is the second layer: it
rejects any request under `/dashboard`, `/agents`, `/leads`, `/campaigns`,
`/calls`, `/settings`, `/admin`, or `/api` that doesn't carry a valid signed
session, before it ever reaches a page. There's no per-route opt-in — both
layers are structural, not a habit to remember on each new route.

## What's implemented (maps to the 9 build-instruction sections)
1. **Auth & multi-tenancy** — register/login/logout, password reset request
   flow (email delivery stubbed — logs the reset link; swap in a real mailer
   plus a `password_reset_tokens` table for production), account/profile
   screen (`/settings/account`).
2. **Customer dashboard** — `/dashboard`: call volume, total calling
   minutes, active campaigns, agent usage, recent calls. Usage only, no
   billing logic.
3. **Agent management** — full CRUD at `/agents`, incl. system prompt,
   greeting/closing, voice, transfer rules, phone-number assignment,
   enable/disable.
4. **Knowledge base** — per-agent source list/add/delete at `/agents/[id]`.
   Storage follows the agreed shape: `knowledge_sources` (raw content, owned
   here) + `knowledge_chunks` (chunks/embeddings via pgvector, owned by
   calling-engine). This UI calls `INGESTION_ENDPOINT_URL` (env var) when a
   source is saved and shows "processing" vs "indexed" based on whether
   chunks exist yet — calling-engine's `/ingest` endpoint is real and
   wired up (see root README), though it needs a self-hosted embedding
   server behind `EMBEDDING_SERVICE_URL` to actually produce vectors.
5. **Telephony connection** — `/settings/telephony`: Twilio/Telnyx
   credential entry, AES-256-GCM encryption before storage (see
   `src/lib/crypto.ts`), masked display only, "verify & sync numbers"
   (currently seeds two representative fixture numbers per provider —
   replace with a real provider API call once ready).
6. **Lead management** — `/leads`: manual add, CSV import with header
   auto-detection (name/phone/email/company + everything else into
   `custom_fields`), profile page with tags/status/notes/call history.
7. **Campaign management** — `/campaigns`: create → pick agent + number +
   leads → start/pause/stop → monitor progress. Start/pause/stop call
   calling-engine's real tenant-scoped dial-queue endpoints (see root
   README) — no longer just flips `status`/timestamps locally.
8. **Call results** — `/calls`: list + detail view with recording player,
   transcript, summary/outcome/sentiment/extracted info, and a "processing"
   state until the call-intelligence pipeline (now part of this project,
   `src/lib/intelligence/` — see root README's "Restructuring" section)
   has populated those fields.
9. **Admin panel** — `/admin` (requires `role: platform_admin`, separate
   from customer accounts): all tenants, platform-wide stats,
   activate/deactivate.

## Second pass — gaps found and closed after the first build
- **Password reset now works end-to-end.** `password_reset_tokens` stores
  only a SHA-256 hash of a random token (1-hour expiry, single-use).
  `/reset-password` requests it, `/reset-password/confirm?token=...` sets
  the new password. Email delivery is still stubbed (logs the link) —
  swap the `console.log` in `requestPasswordResetAction` for a real mailer.
- **Agent "LLM/model selection"** (explicitly listed in build-spec section 3
  but absent from the literal shared-contract table listing) is now a real
  field: `agents.llm_model`. Flagged in the schema comment — sync this
  addition with whoever owns the contract so calling-engine's runtime reads
  it when picking which model to call.
- **Real document upload** for the knowledge base, not just paste-text/URL.
  Files are written to private disk storage (`storage/knowledge/`, gitignored)
  and served back only to the owning tenant via `/api/knowledge-files/[id]`
  — never a public `/uploads` URL, so one tenant can't guess another's file
  path. Text-like files (.txt/.md/.csv) get their content extracted
  immediately; PDFs/Word docs are stored as-is for calling-engine's
  ingestion step to extract. **Move this to S3/Railway volumes with signed
  URLs before production** — local disk won't survive a redeploy on most
  hosts.
- **Campaign schedule & retry settings are now configurable** at creation
  time (calling window, days of week, start time, max attempts, retry
  delay) instead of being hardcoded — stored in the existing
  `campaigns.schedule` / `campaigns.retry_config` JSON columns and shown on
  the campaign detail page.
- **Admin "system/provider configuration"** (build-spec section 9) is now a
  real page at `/admin/settings`: ingestion endpoint URL (overrides the env
  var without a redeploy), default retry policy, available voices list —
  backed by a new `platform_settings` key/value table.

## Third pass — hardening toward a real production SaaS
- **Fixed crash bugs**: deleting an agent with call/campaign history, a lead
  with a booked appointment, or disconnecting a telephony provider still
  used by a campaign would previously throw a raw database foreign-key
  error (several relations are `Restrict`-on-delete). All three are now
  guarded with a clear in-app message instead.
- **Roles are enforced, not just stored.** Agent config, telephony
  connections, workspace renaming, and team management are owner/admin-only
  — members get a read-only view instead of a permission error. Enforced
  both server-side (`assertRole` in `lib/session.ts`, thrown in the action)
  and in the UI (controls are hidden rather than shown-then-rejected).
- **Team management**, closing a real gap: the shared `users` table
  supports multiple accounts per tenant with a role, but nothing covered
  how a second teammate actually gets one. `/settings/team` now supports
  inviting by email (token-based, 7-day expiry, hashed like password
  reset), accepting via `/invite/accept?token=...`, changing roles
  (owner-only), and removing members.
- **Login brute-force protection**: 5 failed attempts locks the account
  for 15 minutes (`users.failed_login_attempts` / `locked_until`).
- **Zod validation** (`src/lib/validation.ts`) on registration, agent
  create/update, and lead create, replacing loose `String(formData.get())`
  coercion with real error messages.
- **Audit log** (`audit_logs` table) for platform-admin actions — tenant
  activate/deactivate, settings changes, telephony connect/disconnect,
  team invites — viewable at `/admin/audit-log`.
- **Pagination** on the leads and calls lists (25/page) instead of a flat
  `take: 100`.
- **Polish**: global `error.tsx` / `not-found.tsx` / dashboard `loading.tsx`,
  a `/api/health` check for deployment monitoring, and basic security
  headers (X-Frame-Options, HSTS, Referrer-Policy, Permissions-Policy) in
  `next.config.js`.

## Remaining known gaps / next steps for whoever picks this up
- Campaign start/pause/stop and knowledge-base ingestion now call
  calling-engine's real endpoints instead of stubs — see root README's
  "What changed during platform integration" for how that got wired up
  (`src/lib/actions/campaigns.ts`, `src/lib/actions/knowledge.ts`).
- **`src/lib/intelligence/`** (summary/outcome/sentiment extraction, lead
  qualification, appointment booking + calendar adapters,
  `/api/webhooks/call-events`) was ported in from a separate
  "intelligence-service" that used to be its own deployable — see root
  README's "Restructuring: three services down to two." This code could
  not be executed in the sandbox it was ported in (same Prisma-binary
  network block that affects this project's own build — see below), so
  treat it as reviewed-but-unexecuted beyond the pure-logic test files
  under `test/`.
- Telephony "verify & sync numbers" seeds fixture numbers rather than
  calling Twilio/Telnyx — replace in `src/lib/actions/telephony.ts`.
- The admin "available voices" setting is stored but not yet wired into
  `AgentForm.tsx`'s (still hardcoded) voice dropdown — noted on the
  settings page itself.
- **This project's TypeScript build/Prisma client generation has never
  been verified to succeed** — `prisma generate` needs to download an
  engine binary from `binaries.prisma.sh`, which was unreachable from
  every sandbox this project (and its later integration/restructuring
  passes) were built in. Run `npm run build` yourself before deploying;
  see root README for the fuller explanation.
- No automated tests yet.
- No rate limiting on registration or the invite/reset-token endpoints
  beyond the per-account login lockout — worth adding IP-based limiting
  at the edge (e.g. a WAF rule) before this is publicly reachable.
- Audit logging currently only covers platform-admin actions; a
  per-tenant "recent activity" log (who invited whom, who changed what)
  would be the natural next addition once someone needs it.
- A user who lacks permission and calls a guarded action directly
  (bypassing the UI, e.g. via devtools) gets an unhandled thrown error
  rather than a clean message — the UI hides the controls so this
  shouldn't come up in normal use, but it's not a polished failure mode.
- `CREDENTIAL_ENCRYPTION_KEY` is a bare env var here; if the deploy target
  has cheap KMS available (AWS KMS / GCP KMS), wrap it there instead — the
  AES-256-GCM-on-the-value part in `src/lib/crypto.ts` doesn't need to
  change either way, only `getMasterKey()`.
- Local disk storage for knowledge-base uploads (`storage/knowledge/`)
  won't survive a redeploy on most hosts — move to S3/Railway volumes
  with signed URLs before production.
