FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip ca-certificates \
  && pip3 install --no-cache-dir yt-dlp \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 10000
CMD ["npm","start"]
