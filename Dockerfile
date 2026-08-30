# Small, boots fast: no build step, two dependencies, plain Node.
FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# Dependencies first, so code edits do not bust the layer cache.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# node:alpine ships an unprivileged `node` user; nothing is written at runtime.
USER node

EXPOSE 3000

# The server answers /api/health as soon as it can serve traffic.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
