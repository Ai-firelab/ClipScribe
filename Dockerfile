# Debian-based Node image: apt-get is available and yt-dlp's glibc binary runs.
FROM node:20-slim

# The yt-dlp binary that youtube-dl-exec downloads is the plain release asset:
# a Python zipapp with a `#!/usr/bin/env python3` shebang, so it needs a system
# python3 at runtime. ffmpeg is required to merge separate video/audio streams.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Skip youtube-dl-exec's postinstall python check; we install python3 above and
# the check probes for a `python` (not `python3`) executable which is absent.
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1

# Install dependencies first to leverage Docker layer caching.
# youtube-dl-exec downloads the yt-dlp binary during postinstall (needs network).
COPY package*.json ./
RUN npm install --omit=dev

COPY . ./

CMD ["npm", "start"]
