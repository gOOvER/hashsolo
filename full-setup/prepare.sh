#!/bin/bash
set -euo pipefail

mkdir -p data/{mainnet,testnet,regtest}/bitcoin
mkdir -p data/{mainnet,testnet,regtest}/public-pool
chown -R 1000:1000 data 2>/dev/null || true
