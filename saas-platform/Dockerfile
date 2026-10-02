# saas-platform - Next.js + Prisma. Needs devDependencies present during
# the build (typescript, tailwind, the prisma CLI for `prisma generate`),
# so this does NOT use --omit=dev like the other two services' Dockerfiles
# - that's deliberate, not an oversight. Single-stage for simplicity over
# image size; revisit with a multi-stage build + `output: "standalone"`
# in next.config.js later if image size becomes a real problem.
FROM node:20-slim

WORKDIR /app

COPY package*.json prisma ./
# prisma/ needs to exist before `npm ci` so its postinstall hook
# (`prisma generate`) can find schema.prisma - copying package.json and
# prisma/ together, before the rest of the source, also keeps Docker's
# layer cache warm across rebuilds that don't touch either.
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 3000

# `prisma db push` here (not in a separate release step) is what actually
# creates/updates the shared schema against Railway's Postgres - this is
# THE migration authority for the whole platform (see ../RAILWAY.md and
# ../README.md). Safe to run on every deploy: db push is additive/
# idempotent for the kind of schema-only changes this project makes.
# --accept-data-loss is NOT passed, so a genuinely destructive schema
# change (dropping a column with data in it) will stop the deploy instead
# of silently discarding data - if that happens, resolve it by hand rather
# than forcing it.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm start"]
