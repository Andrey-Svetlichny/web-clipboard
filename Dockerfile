FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /srv
# No dependencies to install: the server is node:http and node:sqlite, nothing else.
COPY package.json .
COPY server ./server
COPY web ./web

RUN mkdir -p /data && chown node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -q -O- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
