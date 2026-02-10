FROM node:20-alpine

# System deps (no apt-get)
RUN apk add --no-cache \
  python3 py3-pip ffmpeg ca-certificates \
  && pip3 install --no-cache-dir -U yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
