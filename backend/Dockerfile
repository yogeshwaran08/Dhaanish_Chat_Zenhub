FROM node:20-bookworm-slim

# ffmpeg for transcoding WhatsApp voice notes (Ogg/Opus → MP3) so Safari can play them
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/src/ ./src/
COPY backend/scripts/ ./scripts/
COPY db/migrations/ ./db/migrations/

ENV NODE_ENV=production
EXPOSE 3011

CMD ["node", "src/index.js"]
