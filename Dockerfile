FROM node:18-bullseye

RUN apt-get update && apt-get install -y \
    chromium \
    procps \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
COPY . .

EXPOSE 3000
ENV NODE_OPTIONS="--max-old-space-size=384"
CMD ["node", "server.js"]
