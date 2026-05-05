# retold-synth-databeacon — On-demand synthetic record generator
#
# Multi-stage to keep the runtime image lean (no devDeps, no build artifacts
# beyond what the runtime needs). No Pict bundle here — synth has no web UI.
#
# The default port is 8390 to avoid colliding with retold-databeacon's 8389
# in shared compose stacks.

# Stage 1: Build (full deps so npm install resolves cleanly)
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
# `npm install`, not `npm ci` — same Quackage convention as retold-databeacon
# (lockfile is gitignored upstream so `ci` can't pin from the build context).
RUN npm install
COPY source/ source/
COPY bin/ bin/

# Stage 2: Runtime — production deps only
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/source/ source/
COPY --from=builder /app/bin/ bin/

EXPOSE 8390

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "const h=require('http');h.get('http://localhost:8390/synth/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "bin/retold-synth-databeacon.js"]
