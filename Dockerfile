# Debian-based Node image: apt-get is available and yt-dlp's glibc binary runs.
FROM node:20-slim

# ffmpeg is required by yt-dlp to merge separate video/audio streams.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Install dependencies first to leverage Docker layer caching.
# youtube-dl-exec downloads the yt-dlp binary during postinstall (needs network).
COPY package*.json ./
RUN npm install --omit=dev

COPY . ./

CMD ["npm", "start"]
