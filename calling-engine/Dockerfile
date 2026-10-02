# calling-engine - Node/Express, no build step, just needs deps + ffmpeg's
# bundled static binary (downloaded by ffmpeg-static during npm install,
# needs network access at build time - Railway's build environment has it).
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Railway injects PORT at runtime; server.js already reads
# process.env.PORT (falls back to 3000 locally) - EXPOSE here is
# documentation, not what actually controls the bound port.
EXPOSE 3000

# db/migrate.js only creates this service's one exclusive table
# (dnc_numbers) - safe to run on every deploy since it's idempotent
# (CREATE TABLE IF NOT EXISTS). It assumes saas-platform's Prisma schema
# has ALREADY been pushed to the same database - deploy saas-platform
# first, or this will fail with a missing-table error on the FK to
# tenants(id). See ../RAILWAY.md for deployment order.
CMD ["sh", "-c", "node db/migrate.js && node server.js"]
