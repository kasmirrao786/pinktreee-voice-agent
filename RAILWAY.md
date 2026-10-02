# Deploying this platform on Railway

Two services + one shared Postgres, in one Railway project. (This was
three services through the initial integration pass — intelligence-
service was folded into saas-platform afterward; see root `README.md`'s
"Restructuring: three services down to two" for why. If you'd already
deployed the old three-service version, delete the standalone
intelligence-service Railway service once saas-platform's merged version
is live — leaving both up means calling-engine's webhook only reaches
whichever one its URL var still points at, silently orphaning the other.)

This repo is structured for Railway: each service has its own
`Dockerfile` + `railway.toml`.

## 0. Push this to a Git repo first

Railway deploys from a Git repo (GitHub/GitLab) for the normal workflow.
If you'd rather deploy straight from your machine without Git, the
Railway CLI's `railway up` (run from inside each service's directory)
works too - the steps below are the same either way, just substitute
"connect the repo, set Root Directory" with "run `railway up` from that
directory."

## 1. Database — read this before clicking "Add Postgres"

**Railway's default Postgres plugin does NOT include pgvector.** The
knowledge-base feature (`knowledge_chunks.embedding vector(384)`) needs
it. Two options:

- **Recommended:** add Postgres as a Docker Image service instead of the
  plugin — "New" → "Empty Service" → set its image to
  `pgvector/pgvector:pg16`, attach a Volume at `/var/lib/postgresql/data`
  (Railway prompts for this), and set `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB` env vars on it. This gives you a normal Postgres with
  pgvector already compiled in.
- **If you don't need the knowledge-base feature yet:** the default
  Postgres plugin works for everything else. `CREATE EXTENSION vector`
  will just fail during saas-platform's first deploy — comment out the
  `embedding Unsupported("vector(384)")?` line in `prisma/schema.prisma`
  and the corresponding pgvector bits noted in
  `prisma/sandbox-snapshot.sql`, and skip `/ingest` for now.

Either way, once the Postgres service exists, note its connection details
— you'll reference them as `${{Postgres.DATABASE_URL}}` (or whatever you
named that service) in both app services below. Railway auto-populates a
`DATABASE_URL`-shaped variable on Postgres services; if you used the
Docker-image route, construct it yourself as
`postgresql://${{Postgres.POSTGRES_USER}}:${{Postgres.POSTGRES_PASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.POSTGRES_DB}}`.

## 2. Add the two services

For each of `saas-platform/` and `calling-engine/`: "New" → "GitHub Repo"
(pick this repo) → in that service's Settings, set **Root Directory** to
the matching folder name. Railway will find the `Dockerfile` and
`railway.toml` already sitting there and use them automatically — you
shouldn't need to touch the build settings.

## 3. Generate the shared secrets once

Two values must be **byte-for-byte identical** across both services, or
credential decryption / webhook signature verification will fail silently
in confusing ways:

```bash
# CREDENTIAL_ENCRYPTION_KEY - shared by saas-platform + calling-engine
openssl rand -base64 32

# CALL_EVENTS_WEBHOOK_SECRET - shared by saas-platform + calling-engine
# (this used to be shared between calling-engine and the standalone
# intelligence-service - same secret, same purpose, saas-platform verifies
# it now)
openssl rand -base64 32
```

Set each on ONE service, then reference it from the other via Railway's
variable-reference syntax (`${{ServiceName.VAR_NAME}}`) rather than
copy-pasting the value into both places — one source of truth, no risk of
the two drifting apart later.

## 4. Environment variables per service

**Postgres** (whichever service you created in step 1): `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB` (Docker-image route only — the plugin
sets these itself).

**saas-platform:**
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
CREDENTIAL_ENCRYPTION_KEY=<the first value you generated>
CREDENTIAL_ENCRYPTION_KEY_VERSION=1
SESSION_SECRET=<another openssl rand -base64 32 - separate from the two above>
CALLING_ENGINE_URL=http://${{calling-engine.RAILWAY_PRIVATE_DOMAIN}}
INGESTION_ENDPOINT_URL=http://${{calling-engine.RAILWAY_PRIVATE_DOMAIN}}/ingest
CALL_EVENTS_WEBHOOK_SECRET=<the second value you generated>
OPENROUTER_API_KEY=<your real key>
CALENDAR_PROVIDER=mock
```
(Railway private domains resolve over `http://` on the internal network,
not `https://`.)
Then enable a **public domain** for this service (Settings → Networking →
Generate Domain) — this is the customer-facing dashboard, and it's also
where calling-engine's webhook needs to reach if you don't use private
networking between them (private networking, as configured above, is
preferred — faster and doesn't leave the webhook endpoint internet-facing
unnecessarily).

**calling-engine:**
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
CREDENTIAL_ENCRYPTION_KEY=${{saas-platform.CREDENTIAL_ENCRYPTION_KEY}}
SAAS_PLATFORM_URL=http://${{saas-platform.RAILWAY_PRIVATE_DOMAIN}}
CALL_EVENTS_WEBHOOK_SECRET=${{saas-platform.CALL_EVENTS_WEBHOOK_SECRET}}
OPENROUTER_API_KEY=<your real key>
PUBLIC_HOSTNAME=<set AFTER step 5 below - see note>
CALL_HOURS_TZ=America/New_York
CALL_HOURS_START=9
CALL_HOURS_END=20
MAX_CONCURRENT_CALLS=5
EMBEDDING_SERVICE_URL=<if you're standing one up - see root README>
KOKORO_TTS_URL=<your self-hosted Kokoro instance, if using it>
```
This one needs a **public domain** too (Twilio/Telnyx must be able to
reach `/voice`, `/call-status`, `/telnyx/webhook` from the internet — a
private-network-only domain won't work for this service).

**Note on `PUBLIC_HOSTNAME`:** you can't know calling-engine's public
domain until Railway assigns it, which happens after you enable
Networking on it. Deploy once without `PUBLIC_HOSTNAME` set (or a
placeholder), let Railway generate the domain, copy it in
(`your-app.up.railway.app`, no `https://`, no trailing slash), then
redeploy calling-engine.

## 5. Deployment order matters — this bit isn't optional

saas-platform's Dockerfile `CMD` runs `prisma db push` before starting —
that's what actually creates the shared schema, including `dnc_numbers`
and the two tables (`processed_call_events`, `tenant_calendar_config`) the
intelligence pipeline needs (all three now live in `schema.prisma`
directly - `dnc_numbers` was originally meant to be calling-engine's own
table, but turned out to have been added to Prisma's schema too during
the original integration; that duplicate ownership is resolved now, see
root README, and Prisma is the sole owner). calling-engine's Dockerfile
still runs its own migration step, but it's a no-op — every table it
touches already exists once saas-platform's push has landed, and it just
verifies connectivity before starting the server.

1. Deploy **saas-platform** first. Wait for it to go healthy
   (`/api/health` returns 200).
2. Then deploy **calling-engine**.

If you deploy both at once and calling-engine fails on its first attempt
with a foreign-key/missing-table error, that's why — just redeploy it
once saas-platform's schema push has actually landed. Railway doesn't
have a built-in "wait for another service" primitive for this, so it's a
manual first-deploy step, not a config setting.

## 6. Point Twilio/Telnyx at calling-engine

Once calling-engine has a public domain, configure each provider's
console:
- **Twilio**: the voice webhook Twilio calls is set per-call by
  calling-engine itself (`voiceUrl` in the dial request) — nothing to
  configure in Twilio's console for this beyond your phone number/Account
  SID being valid.
- **Telnyx**: your Call Control Application's webhook URL is also passed
  per-call (`webhookUrl` in the dial request) — same story, nothing extra
  needed in Telnyx's dashboard beyond a valid Connection ID.
- Both providers' credentials themselves are entered per-tenant in
  saas-platform's Settings → Telephony page, not as Railway env vars (see
  root README's "What changed during platform integration" for why).

## 7. One-time: seed demo data (optional)

```bash
railway run --service saas-platform npm run db:seed
```

## Known gaps carried over from the sandbox integration work

These apply on Railway exactly as documented in the root `README.md`'s
"What's still not wired" section — nothing about deploying to Railway
changes them: no embedding server exists yet behind
`EMBEDDING_SERVICE_URL`, STT is still Deepgram-only (no self-hosted
option wired up), and neither saas-platform's TypeScript build/Prisma
schema push NOR the newly-ported intelligence pipeline's Prisma-dependent
code were ever executed in the sandbox this was built in (Prisma's CLI
couldn't reach `binaries.prisma.sh` from there). Railway's build
environment has normal internet access, so `prisma generate` and
`prisma db push` should both work fine there — this is the first time
they'll actually run for real, for both the original schema and the
intelligence-pipeline code added when three services became two. Watch
the saas-platform build/deploy logs closely on that first deploy, and
consider running `npm test` (from saas-platform, with `DATABASE_URL` set)
against the deployed database once it's up, to close the "ported but
unexecuted" gap the root README flags for `eventHandler.integration.test.ts`.
