FROM node:20-alpine

WORKDIR /app

# Install system dependencies (no pip to avoid PEP 668)
RUN apk add --no-cache python3 ffmpeg ca-certificates yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
