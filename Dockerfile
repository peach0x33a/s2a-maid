FROM oven/bun:1 AS test
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json config.example.toml README.md ./
COPY src ./src
COPY test ./test

RUN bun test
RUN bunx tsc --noEmit

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && bun pm cache rm

COPY --from=test /app/src ./src
COPY config.example.toml README.md ./

VOLUME ["/data"]
ENV S2A_CONFIG_PATH=/data/config.toml

CMD ["sh", "-c", "bun run src/index.ts --config \"${S2A_CONFIG_PATH}\""]
