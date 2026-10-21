FROM node:22-alpine AS builder
WORKDIR /app

# `npm ci` runs the `postinstall` hook (`prisma generate`), which reads the
# schema and prisma.config.ts. They must be copied before the install step.
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 app && adduser -u 1001 -G app -s /bin/sh -D app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then((r) => (r.ok ? process.exit(0) : process.exit(1))).catch(() => process.exit(1))"
CMD ["node", "dist/server.js"]
