<div align="center">

  # ⛏️ HashSolo

  **Hardened, High-Performance Bitcoin Solo Mining Pool (Stratum V1) on Node.js 26**

  [![CI](https://github.com/gOOvER/hashsolo/actions/workflows/ci.yml/badge.svg)](https://github.com/gOOvER/hashsolo/actions/workflows/ci.yml)
  [![Docker Build & Publish](https://github.com/gOOvER/hashsolo/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/gOOvER/hashsolo/actions/workflows/docker-publish.yml)
  [![Trivy Security Scan](https://github.com/gOOvER/hashsolo/actions/workflows/trivy-analysis.yml/badge.svg)](https://github.com/gOOvER/hashsolo/actions/workflows/trivy-analysis.yml)
  [![Node.js](https://img.shields.io/badge/Node.js-26%2B-339933?logo=node.js&logoColor=white)](.nvmrc)
  [![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE.txt)
  [![Support](https://img.shields.io/badge/Support-donate.goover.dev-ff69b4?logo=ko-fi&logoColor=white)](https://donate.goover.dev)

</div>

> [!NOTE]
> **Fork Notice:** HashSolo is an actively maintained, hardened fork of [`benjamin-wilson/public-pool`](https://github.com/benjamin-wilson/public-pool).
> For a ready-to-run **Dokploy** Docker Compose stack (including Bitcoin Core, HashSolo backend, and HashSolo UI), see **[gOOvER/hashsolo-dokploy](https://github.com/gOOvER/hashsolo-dokploy)**.

---

## ✨ Ecosystem

| Component | Repository | Container Image |
| :--- | :--- | :--- |
| **Backend (this repo)** | [`gOOvER/hashsolo`](https://github.com/gOOvER/hashsolo) | `ghcr.io/goover/hashsolo:latest` |
| **Web Dashboard** | [`gOOvER/hashsolo-ui`](https://github.com/gOOvER/hashsolo-ui) | `ghcr.io/goover/hashsolo-ui:latest` |
| **Dokploy Stack (Recommended)** | [`gOOvER/hashsolo-dokploy`](https://github.com/gOOvER/hashsolo-dokploy) | `bitcoind` + `hashsolo` + `hashsolo-ui` |

---

## 🚀 Key Improvements in This Fork

- **Modern Runtime & Stack:** Node.js `26`, NestJS `12`, TypeORM `1.x` (`better-sqlite3`), `bitcoinjs-lib` `7`, TypeScript `6`, Jest `30`, ESLint `10`.
- **Live Node & Reward Endpoints:**
  - `GET /api/node/status`: Live `bitcoind` sync progress (`blocks`, `headers`, `verificationProgress`, `pruned`, `sizeOnDisk`, `connections`).
  - `GET /api/info/next-block-reward`: Live `coinbasevalue` (`rewardSats`, `subsidySats`, `feeSats`, `height`) from the current block template.
  - `GET /api/metrics`: Prometheus text exposition endpoint for Grafana/Prometheus monitoring.
- **Dynamic Fee Reporting:** `/api/info` and `/api/pool` expose `fee` dynamically (`1.5` when `DEV_FEE_ADDRESS` is configured for miners `>= 50 TH/s`, `0` otherwise).
- **Notifications & Bot Commands:**
  - Telegram bot commands: `/subscribe <address>`, `/stats [address]`, `/workers [address]`.
  - Best-difficulty (`BEST_DIFF_ALERT_MIN`) and worker online/offline (`DEVICE_NOTIFICATIONS_ENABLED`) alerts via Telegram and **ntfy** (`NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN`).
- **Performance & Security Hardening:**
  - Non-root Docker image (`node`), configurable `CORS_ORIGIN`, graceful shutdown hooks.
  - Synchronous `mining.submit` parser/validator on the Stratum hot path and pre-cached Merkle branches.
  - SQLite WAL mode with `PRAGMA synchronous = NORMAL`, `PRAGMA optimize;` on cleanup, and per-session rejected share reason tracking (`rejectedLowDiff`, `rejectedStaleJob`, `rejectedDuplicate`).
  - Configurable VarDiff & start difficulty (`STRATUM_START_DIFF`, `VARDIFF_TARGET_TIME`, `VARDIFF_MIN_DIFF`) — great for KH/s miners like NMMiner as well as TH/s ASICs.

---

## 🐳 Dokploy Deployment (Recommended)

Deploy the entire stack (`bitcoind` + `hashsolo` + `hashsolo-ui`) in minutes using **[gOOvER/hashsolo-dokploy](https://github.com/gOOvER/hashsolo-dokploy)**:
- Preconfigured `pull_policy: always` with native `linux/amd64` GHCR images.
- Built-in Caddy `/api/*` reverse proxy so only one domain is needed.

---

## 🛠️ Local Development & Testing

```bash
npm install
cp .env.example .env
```

```bash
# development
npm run start:dev

# production build
npm run build
npm run start:prod

# unit tests (Jest 30 + Node ESM) & lint
npm run test
npm run lint
```

### Requirements
- **Node.js `26.0.0` or newer** (see `.nvmrc`)
- **Bitcoin Core** with RPC enabled (`rpcallowip` configured) and optional ZMQ (`zmqpubrawblock`)

### PM2 Cluster Mode & TLS
- `NODE_CLUSTER_SCHEDPOLICY=none pm2 start ecosystem.config.js` (`STRATUM_MAX_CONNECTIONS_PER_LISTENER` defaults to `10000`).
- Behind a reverse proxy (Dokploy / Traefik / Caddy / Nginx), keep `API_SECURE=false` and let the proxy terminate HTTPS.

---

## 💝 Support

If you find **HashSolo** useful:
- **Donate / Ko-fi / Buy Me a Coffee:** [donate.goover.dev](https://donate.goover.dev)
- **Bitcoin (BTC Mainnet):** `bc1qt6wec64n3gnrhclp4vfckyvr8h27tmqswy28gc`
