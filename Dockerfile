############################
# Docker build environment #
############################

FROM node:26-bookworm-slim AS build

# Upgrade all packages and install dependencies
RUN apt-get update \
    && apt-get upgrade -y
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        cmake \
        curl \
        ca-certificates \
    && apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /build

COPY . .

# Build HashSolo using NPM and prune devDependencies for a lean runtime image
RUN npm ci && npm run build && npm prune --omit=dev

############################
# Docker final environment #
############################

FROM node:26-bookworm-slim

# Expose ports for Stratum and Bitcoin RPC
EXPOSE 3333 3334 8332

WORKDIR /hashsolo
ENV NODE_COMPILE_CACHE=/tmp/node-compile-cache

# Copy only production artifacts into the final image
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules

RUN mkdir -p /hashsolo/DB && chown -R node:node /hashsolo
USER node

CMD ["/usr/local/bin/node", "dist/main"]
