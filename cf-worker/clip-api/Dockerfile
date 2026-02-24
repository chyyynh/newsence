FROM --platform=linux/amd64 node:20-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg libass9 fonts-noto-cjk && \
    pip3 install --break-system-packages yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY container/package.json container/pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false
COPY container/tsconfig.json ./
COPY container/src/ ./src/
RUN pnpm build

EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/index.js"]
