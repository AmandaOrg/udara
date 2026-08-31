# Production image for Railway. Nixpacks was running npm ci twice (install
# phase + custom buildCommand) which EBUSY-locked node_modules/.cache.
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install while NODE_ENV is unset so npm does not omit nest CLI / TypeScript.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Migrate against DATABASE_URL at boot, then node dist/main.js.
CMD ["node", "scripts/start-prod.js"]
