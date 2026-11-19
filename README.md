# HashSolo

> **Fork Notice:** HashSolo is an actively maintained, hardened fork of [`benjamin-wilson/public-pool`](https://github.com/benjamin-wilson/public-pool).
> For a ready-to-run **Dokploy** stack (including Bitcoin Core, HashSolo backend, and HashSolo UI), see **[gOOvER/hashsolo-dokploy](https://github.com/gOOvER/hashsolo-dokploy)**.

A hardened NestJS and TypeScript Bitcoin Solo Mining Pool (Stratum v1) running on **Node.js 26** with TypeORM (`better-sqlite3`).

## Related Repositories

- **Backend (this repo):** [`gOOvER/hashsolo`](https://github.com/gOOvER/hashsolo) (`ghcr.io/goover/hashsolo:latest`)
- **Web Dashboard:** [`gOOvER/hashsolo-ui`](https://github.com/gOOvER/hashsolo-ui) (`ghcr.io/goover/hashsolo-ui:latest`)
- **Dokploy Compose Stack (Recommended):** [`gOOvER/hashsolo-dokploy`](https://github.com/gOOvER/hashsolo-dokploy)

## Key Improvements in This Fork

- **Modern Runtime & Stack:** Node.js `26`, NestJS `12`, TypeORM `1.x` (`better-sqlite3`), `bitcoinjs-lib` `7`, TypeScript `6`, Jest `30`, ESLint `10`.
- **Live Bitcoin Node Status:** Added `GET /api/node/status` (`getblockchaininfo`) reporting live sync progress, blocks/headers, pruning, and disk usage to the UI.
- **Dynamic Fee Reporting:** `/api/info` and `/api/pool` dynamically expose `fee` (`1.5` when `DEV_FEE_ADDRESS` is set for miners `>= 50 TH/s`, `0` otherwise).
- **Performance & Security Hardening:**
  - Non-root Docker image (`node` user), configurable `CORS_ORIGIN`, graceful shutdown hooks.
  - Synchronous `mining.submit` parser/validator on the Stratum hot path and pre-cached Merkle branches.
  - SQLite `PRAGMA synchronous = NORMAL` with WAL mode and composite statistics indexes.
  - TCP buffer overflow protection and per-listener `STRATUM_MAX_CONNECTIONS_PER_LISTENER`.

## Dokploy Deployment (Recommended)

The easiest way to deploy HashSolo in production is with **[gOOvER/hashsolo-dokploy](https://github.com/gOOvER/hashsolo-dokploy)**:
- Includes `bitcoind` (`bitcoin/bitcoin:latest`, pruned by default via `BITCOIN_PRUNE=550`), `hashsolo`, and `hashsolo-ui` in one Compose stack.
- Uses `pull_policy: always` with prebuilt `linux/amd64` GHCR images.
- Routes `/api/*` internally via Caddy so only one domain is needed in Dokploy.

## Installation (Local / Manual)

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
NODE_CLUSTER_SCHEDPOLICY=none pm2 start ecosystem.config.js
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
