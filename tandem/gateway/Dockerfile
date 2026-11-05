FROM oven/bun:1 AS web
WORKDIR /build/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
COPY branding/ /build/branding/
RUN bun run build

FROM oven/bun:1 AS gateway
WORKDIR /build/gateway
COPY gateway/package.json gateway/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY gateway/src ./src

FROM oven/bun:1-slim
WORKDIR /app
RUN groupadd --gid 10001 tandem && useradd --uid 10001 --gid 10001 --no-create-home tandem && mkdir -p /var/lib/tandem && chown 10001:10001 /var/lib/tandem
COPY --from=gateway --chown=10001:10001 /build/gateway /app
COPY --from=web --chown=10001:10001 /build/web/dist /app/public
COPY --chown=10001:10001 branding/brand.json /app/brand.json
COPY --chown=10001:10001 branding/logo.svg /app/public/favicon.svg
ENV TANDEM_DATA_DIR=/var/lib/tandem TANDEM_PUBLIC_DIR=/app/public TANDEM_BRAND_FILE=/app/brand.json
USER 10001:10001
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:8790/api/health'); const h = await r.json(); process.exit(r.ok && h.ok ? 0 : 1)"]
CMD ["bun", "src/index.ts"]
