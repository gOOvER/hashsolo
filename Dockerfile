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

# Expose ports for Stratum V1, Stratum V1 TLS, Stratum V2, API, and Bitcoin RPC
EXPOSE 3333 3334 4333 8332 23330

WORKDIR /hashsolo
ENV NODE_COMPILE_CACHE=/tmp/node-compile-cache

# Copy only production artifacts into the final image
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
       /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p /hashsolo/DB && chown -R node:node /hashsolo
USER node

CMD ["/usr/local/bin/node", "dist/main"]
