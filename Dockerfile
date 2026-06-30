# Debian-based Node image: glibc is available so the yt-dlp binary runs, and
# apt-get is available for ffmpeg.
FROM node:20-slim

# ffmpeg merges separate video/audio streams; ca-certificates is needed for HTTPS
# to GitHub (binary download + self-update) and to Instagram.
# NOTE: no python3 — we use the self-contained yt-dlp_linux build (see below),
# which bundles its own Python interpreter.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Download the self-contained PyInstaller build (yt-dlp_linux) instead of the
# default python zipapp. This gives us two things the zipapp can't:
#   1. No system python3 dependency at runtime.
#   2. Working `yt-dlp -U` self-update, so the actor pulls the newest Instagram
#      extractor fixes at startup (see refreshYtDlpBinary in src/main.js).
ENV YOUTUBE_DL_FILENAME=yt-dlp_linux
# Skip youtube-dl-exec's python preinstall probe (we ship no python).
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1

# Install dependencies first to leverage Docker layer caching.
# youtube-dl-exec's postinstall downloads the latest yt-dlp_linux release (needs
# network). Bump CACHEBUST (or build with --build-arg CACHEBUST=$(date +%s)) to
# force a fresh binary download on rebuild instead of reusing a stale cached layer.
# Runtime self-update covers staleness between builds; this is the build-time lever.
ARG CACHEBUST=1
COPY package*.json ./
RUN npm install --omit=dev

COPY . ./

CMD ["npm", "start"]
