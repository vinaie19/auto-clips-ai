# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY index.js ./
COPY pipeline ./pipeline
COPY deploy ./deploy

ENV NODE_ENV=production
ENV STUB_RENDER=0

CMD ["node", "index.js"]
