# HashSolo

A hardened NestJS and TypeScript Bitcoin Solo Mining Pool (Stratum v1) running on **Node.js 26** with TypeORM (`better-sqlite3`).

## Installation

```bash
npm install
```

Create a `.env` file in the root directory and configure it using `.env.example`.

## Running the app

```bash
# development
npm run start

# watch mode
npm run start:dev

# production build
npm run build
npm run start:prod
```

## Test & Lint

```bash
# unit tests (Jest 30 + Node ESM)
npm run test

# test coverage
npm run test:cov

# lint
npm run lint
```

## Requirements

- **Node.js `26.0.0` or newer** (see `.nvmrc`)
- **Bitcoin Core** with RPC enabled (`rpcallowip` configured) and optional ZMQ (`zmqpubrawblock`)

## Deployment (PM2 Cluster Mode)

```bash
pm2 start dist/main.js
```

When running in PM2 cluster mode, start the PM2 daemon with OS-level connection scheduling:

```bash
NODE_CLUSTER_SCHED_POLICY=none pm2 start ecosystem.config.js
```

`STRATUM_MAX_CONNECTIONS_PER_LISTENER` is enforced per worker and Stratum port (default `10000`).

## HTTPS / TLS (`API_SECURE`)

If `API_SECURE=true`, the API server reads TLS credentials from:
- `secrets/key.pem`
- `secrets/cert.pem`

When running behind a reverse proxy (e.g. Dokploy / Traefik / Nginx / Caddy), keep `API_SECURE=false` and let the proxy terminate TLS.

## Docker

Build container:

```bash
docker build -t hashsolo .
```

Run container:

```bash
docker container run --name hashsolo --rm -p 3333:3333 -p 3334:3334 -v $(pwd)/.env:/hashsolo/.env:ro -v hashsolo-db:/hashsolo/DB hashsolo
```

### Docker Compose

```bash
docker compose build
docker compose up -d
```

Note: To connect to Bitcoin Core RPC from Docker, add `rpcallowip=172.16.0.0/12` to `bitcoin.conf`.
