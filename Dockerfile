FROM node:20-alpine

# ffmpeg + yt-dlp from apk (no pip)
RUN apk add --no-cache python3 ffmpeg ca-certificates yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080
CMD ["node", "server.js"]
