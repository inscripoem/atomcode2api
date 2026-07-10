FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json tsconfig.json ./

ENV PORT=3456
ENV HOST=0.0.0.0
EXPOSE 3456

CMD ["bun", "run", "src/index.ts"]
