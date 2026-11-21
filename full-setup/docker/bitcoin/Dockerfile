FROM ubuntu:24.04 AS build

ARG BITCOIN_CORE_VER=28.1
ARG TARGETARCH

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates wget tar && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download and extract Bitcoin Core for the target architecture (amd64 / arm64)
RUN case "${TARGETARCH}" in \
      "amd64"|"") ARCH="x86_64-linux-gnu" ;; \
      "arm64") ARCH="aarch64-linux-gnu" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    wget -qO- "https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_CORE_VER}/bitcoin-${BITCOIN_CORE_VER}-${ARCH}.tar.gz" | tar xz --strip-components=1

FROM gcr.io/distroless/cc-debian12:nonroot

COPY --chown=1000:1000 --from=build /app /app

# Expose RPC and P2P ports for mainnet (8332/8333) and testnet (18332/18333)
EXPOSE 8332 8333 18332 18333

ENTRYPOINT ["/app/bin/bitcoind"]

USER 1000:1000

CMD ["-printtoconsole", "-datadir=/app/data"]
