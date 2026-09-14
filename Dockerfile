FROM node:24-alpine
LABEL org.opencontainers.image.title="BankMCP™" \
      org.opencontainers.image.description="Read-only MCP server for your own bank accounts via Enable Banking. Self-hosted, one user." \
      org.opencontainers.image.source="https://github.com/noskillish/bankmcp" \
      org.opencontainers.image.url="https://bankmcp.dk/" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.noskillish/bankmcp"
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.ts"]
