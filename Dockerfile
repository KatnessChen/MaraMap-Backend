# Stage 1: Build
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY src/ nest-cli.json tsconfig.json tsconfig.build.json ./
RUN pnpm run build

# Stage 2: Run
FROM node:20-alpine AS runner

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

EXPOSE 8080

ENV PORT=8080
CMD ["node", "dist/main.js"]
