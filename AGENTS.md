# AGENTS.md — HashSolo Backend

## Overview
**HashSolo** is an actively maintained, hardened open-source (**GPL-3.0**) fork of [`benjamin-wilson/public-pool`](https://github.com/benjamin-wilson/public-pool) for self-hosted Bitcoin **Solo** mining.

- **Runtime:** Node.js `>= 26.0.0` (`.nvmrc`: `26`), TypeScript `6.x`, NestJS `12` (`@nestjs/platform-fastify`), TypeORM `1.x` (`better-sqlite3` in WAL mode), `bitcoinjs-lib` `7.x`, Jest `30` (ESM mode).
- **Companion Repos:**
  - Web UI: [`gOOvER/hashsolo-ui`](https://github.com/gOOvER/hashsolo-ui)
  - Dokploy Stack: [`gOOvER/hashsolo-dokploy`](https://github.com/gOOvER/hashsolo-dokploy)

## Commands
```bash
npm ci
npm run build   # nest build
npm test        # node --experimental-vm-modules ./node_modules/jest/bin/jest.js
npm run lint    # eslint "{src,apps,libs,test}/**/*.ts" --fix
```

## Architecture Map
- `src/main.ts` — Fastify bootstrap, `/api` global prefix, `/metrics` Prometheus alias, `CORS_ORIGIN`, shutdown hooks.
- `src/app.controller.ts` — `/api/info`, `/api/info/miners`, `/api/info/accounting`, `/api/node/status`, `/api/metrics`, `/api/info/chart`.
- `src/services/stratum-v1.service.ts` & `src/models/StratumV1Client.ts` — Stratum V1 TCP (`STRATUM_PORT=3333`) + optional native TLS (`STRATUM_TLS_ENABLED`, `STRATUM_TLS_PORT=4333`), backpressure monitor, VarDiff, hot-path `mining.submit` parser.
- `src/services/stratum-v2.service.ts`, `src/models/StratumV2Client.ts`, `src/stratum-v2/` — Optional native Stratum V2 (`STRATUM_V2_ENABLED`, `STRATUM_V2_PORT=23330`) using `Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256` (`ellswift.ts`, `noise.ts`, `protocol.ts`).
- `src/services/bitcoin-rpc.service.ts` & `src/services/stratum-v1-jobs.service.ts` — Bitcoin Core RPC (`keepAlive`), ZMQ `hashblock` / `rawblock`, `MiningJob` template management.
- `src/ORM/` — SQLite entities & services (`DateTimeTransformer` stores UTC `YYYY-MM-DD HH:MM:SS`).
- `src/services/discord.service.ts`, `telegram.service.ts`, `ntfy.service.ts` — Notifications and Discord Components V2 bot with `@resvg/resvg-js` PNG charts.
- `full-setup/` — Multi-arch standalone Docker Compose setups (`mainnet`, `testnet`, `regtest`) + `grafana-dashboard.json`.

## Project Conventions
1. **Everything must be configurable:** This is an open-source self-hostable project. Never hardcode private domains, keys, or pool-specific settings without an environment variable override (`.env.example` & `README.md` must stay in sync).
2. **Changelog (`CHANGELOG.md`):** Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Never edit frozen released blocks (`## [X.Y.Z]`); add all new changes under `## [Unreleased]`.
3. **Security & Docker:**
   - Keep `Dockerfile` running as non-root `node` without unused global `npm`/`npx` in the final runtime stage.
   - Exclude `secrets/` in `.dockerignore`.
   - Keep `npm audit` clean (`0` vulnerabilities) and verify `npm run build` + `npm test` after every change.
4. **CI & Rulesets:** Default branch `master` requires `build-and-test` ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)); Trivy & CodeQL scan on push/PR.
