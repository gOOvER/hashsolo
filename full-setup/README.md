# Full Setup for HashSolo

This setup provides a Docker Compose stack consisting of a **Bitcoin Core** node (`28.1`, multi-arch `amd64` / `arm64`) and **HashSolo** running in Mainnet, Testnet, or Regtest.

> **Dokploy Deployment:** If you are deploying on Dokploy with the web UI (`hashsolo-ui`), see [`gOOvER/hashsolo-dokploy`](https://github.com/gOOvER/hashsolo-dokploy) instead.

## Exposed Ports

- `8332 / 18332 / 28332`: Bitcoin RPC on `127.0.0.1`
- `8333 / 18333 / 28333`: Bitcoin P2P on `0.0.0.0`
- `3333 / 13333 / 23333`: HashSolo Stratum V1 port on `0.0.0.0`
- `3334 / 13334 / 23334`: HashSolo REST & Prometheus `/api/metrics` port on `127.0.0.1`

The Mainnet, Testnet, and Regtest stacks can be run in parallel without port conflicts.

## Building Images

```bash
docker compose -f docker-compose-mainnet.yml build
```

Replace `-mainnet` with `-testnet` or `-regtest` as needed.

## Preparing Directories

Before starting the setup, create the persistent data directories (and set non-root ownership `1000:1000`):

```bash
sudo ./prepare.sh
```

## Config Files

- **Mainnet:** `public-pool-mainnet.env`, `bitcoin-mainnet.conf`
- **Testnet:** `public-pool-testnet.env`, `bitcoin-testnet.conf`
- **Regtest:** `public-pool-regtest.env`, `bitcoin-regtest.conf`
- **Monitoring:** `grafana-dashboard.json` (Prometheus `/api/metrics` dashboard)

> **Note:** Pruning (`prune=550`) is enabled by default in the Bitcoin configs.

## Running the Setup

```bash
# Foreground
docker compose -f docker-compose-mainnet.yml up

# Detached / background
docker compose -f docker-compose-mainnet.yml up -d

# Follow logs
docker compose -f docker-compose-mainnet.yml logs --tail 100 -f

# Stop
docker compose -f docker-compose-mainnet.yml down
```

## Regtest

After starting the `regtest` stack, create a wallet and generate initial blocks:

```bash
# create wallet
docker exec -it bitcoin-regtest /app/bin/bitcoin-cli -conf=/app/data/bitcoin.conf -regtest createwallet "regtestwallet"

# generate 101 blocks
docker exec -it bitcoin-regtest /app/bin/bitcoin-cli -conf=/app/data/bitcoin.conf -regtest -generate 101
```
