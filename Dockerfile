FROM node:20-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache python3 py3-pip ffmpeg ca-certificates \
    && pip3 install --no-cache-dir -U yt-dlp

# Copy package files
COPY package*.json ./

# Use npm install instead of npm ci
RUN npm install --omit=dev

# Copy project files
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
