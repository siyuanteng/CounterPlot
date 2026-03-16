FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build frontend
COPY . .
RUN npm run build

# Cloud Run injects PORT at runtime (default 8080)
EXPOSE 8080

CMD ["node_modules/.bin/tsx", "server/index.mjs"]
