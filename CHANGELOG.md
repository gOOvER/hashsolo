# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Added per-address `accounting` summary (`bestSubmissionDifficulty`, `totalCreditedDifficulty`, `creditedDifficultyLastHour`, `creditedDifficultyLast10Minutes`) to `GET /api/client/:address` via `ClientStatisticsService.getAccountingSummary(address?)`.
- Added `full-setup/grafana-dashboard.json` for Prometheus `/api/metrics` visualization and `src/app.controller.spec.ts` unit tests for `infoAccounting()`.
- Added `GET /api/info/accounting` (`AppController.infoAccounting` / `ClientStatisticsService.getAccountingSummary`) returning live Solo Mining metrics (`bestSubmissionDifficulty`, `totalCreditedDifficulty`, `creditedDifficultyLastHour`, `creditedDifficultyLast10Minutes`, `hashRateLast10Minutes`, `hashRateLastHour`) with a 15s cache.
- Upgraded `DiscordService` to full **Discord Components V2** (`MessageFlags.IsComponentsV2`, `ContainerBuilder`, `TextDisplayBuilder`, `SeparatorBuilder`, `MediaGalleryBuilder`, `ActionRowBuilder`) with `/pool`, `/node`, `/stats`, `/workers`, `/chart`, `/subscribe`, and `/unsubscribe` slash commands, interactive refresh buttons, live watching presence (`X Miners · Y MH/s`), `DiscordSubscriptionsEntity` persistence, and Best-Difficulty / Worker Online-Offline / Block Found / Server Restart alerts.
- Added local dark-mode SVG-to-PNG hashrate chart renderer (`src/services/discord-chart.util.ts` via `@resvg/resvg-js`) for Discord `/pool`, `/stats`, and `/chart` responses.

### Fixed
- Normalized `NMMiner` user-agent variants (e.g. `Nerd-NMMiner/...`) to `NMMiner` and truncated `Nerd` prefixes (e.g. `Nerd Miner/...`) to `NerdMiner` in `SubscriptionMessage.refineUserAgent()`.
- Enabled TCP keep-alive (`30s`) and idle socket timeout (`180s`) on `StratumV1Client` and shortened `ClientService.killDeadClients()` stale threshold from 5 minutes to 2 minutes so dropped ESP32/Wi-Fi sessions clear faster.
- Fixed the `N/(N-1)` off-by-one interval bias in `StratumV1ClientStatistics.getSuggestedDifficulty()` (`submissionCache.slice(1)`, upstream `#167`).

### Changed
- Exposed `rejectedLowDiff`, `rejectedStaleJob`, and `rejectedDuplicate` per worker in `GET /api/client/:address`.

## [1.0.0] - 2026-11-19

### Added
- Added `GET /api/info/miners` (`AppController.connectedMiners` / `ClientService.getConnectedMiners`) returning all active connected miner sessions with masked addresses, worker names, user agents, hashrates, best difficulties, and timestamps (15s cache).
- Added `/stats [address]` and `/workers [address]` commands to `TelegramService` plus `getSubscriptionsByChatId` in `TelegramSubscriptionsService`.
- Added per-session rejected share reason tracking (`rejectedLowDiff`, `rejectedStaleJob`, `rejectedDuplicate`) on `ClientEntity` / `ClientService` / `StratumV1Client`.
- Added configurable VarDiff & start difficulty ENV options (`STRATUM_START_DIFF`, `VARDIFF_TARGET_TIME`, `VARDIFF_MIN_DIFF`) and SQLite `PRAGMA optimize;` after statistics cleanup.
- Added Prometheus `/api/metrics` endpoint exposing pool hashrate, connected miners, found blocks, Bitcoin node sync/peers, and next-block reward.
- Added `NtfyService` (`NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN`) and extended `NotificationService` / `TelegramService` with new best-difficulty (`BEST_DIFF_ALERT_MIN`) and worker online/offline (`DEVICE_NOTIFICATIONS_ENABLED`) alerts.
- Added `GET /api/info/next-block-reward` (`rewardSats`, `subsidySats`, `feeSats`, `height`) from the latest `getblocktemplate` `coinbasevalue`.
- Added `connections` (Bitcoin P2P peer count from `getnetworkinfo`) to `GET /api/node/status`.
- Added `GET /api/node/status` endpoint and `BitcoinRpcService.getBlockchainInfo()` to report live `bitcoind` sync state (`reachable`, `ready`, `blocks`, `headers`, `verificationProgress`, `initialBlockDownload`, `pruned`, `sizeOnDisk`).
- Added `.nvmrc` (`26`) for Node.js 26 default runtime selection.
- Added composite indexes on `ClientStatisticsEntity` (`['address', 'time']` and `['address', 'clientName', 'time']`) for chart queries.
- Added unit tests for `nearestPowerOfTwo` overflow handling, zero-delta division guards, TCP buffer overflow protection, non-positive `suggestedDifficulty` rejection, and `versionMask` validation.

### Fixed
- Cleared stale active `ClientEntity` sessions (`clientService.deleteAll()` soft-delete) on startup in `AppService.onModuleInit()` and shortened the `killDeadClients()` sweep interval from 5 minutes to 1 minute so container restarts never leave duplicate phantom worker sessions.
- Fixed `SubscriptionMessage.refineUserAgent()` matching `bosminer`/`bOS`/`cpuminer` before truncating at `-`/`/`/`V`/space so newer Braiins OS user agents (`2026-...;bosminer...`) report as `Braiins OS` instead of `2026`, and bare version/date prefixes fall back to the first whole token (`Vnish/1.2` -> `Vnish`).
- Added `isNewPrevHash` detection in `StratumV1JobsService` so block reorgs at the same height also trigger `clearJobs = true`.
- Clamped initial first-slot `StratumV1ClientStatistics` hashrate denominator to at least 60 seconds when `previousShares === 0` to prevent startup hashrate spikes from early shares.
- Fixed `StratumV1JobsService` `merkle_branch` serialization for `bitcoinjs-lib` v7 (`Uint8Array` -> `Buffer.from(...)` so `mining.notify` sends 64-char hex hashes instead of comma-separated decimal byte strings).
- Persisted `ClientEntity` immediately on `mining.authorize` in `StratumV1Client` so newly connected miners appear in the UI before submitting their first share.
- Stopped calling `resetBestDifficultyAndShares()` on block found in `StratumV1Client` so address `bestDifficulty` and `shares` are preserved across blocks (inspired by `blitzpool`).

### Changed
- Enabled HTTP/HTTPS `keepAlive` agents on `BitcoinRpcService` and subscribed ZMQ to both `hashblock` (45-byte notifications) and `rawblock` (backward compatibility).
- Computed `fee` dynamically (`1.5` when `DEV_FEE_ADDRESS` is configured, `0` otherwise) in `/api/info` and `/api/pool`.
- Set Node.js 26 as the default runtime (`Dockerfile` updated to `node:26-bookworm-slim`, `package.json` `engines.node` set to `>=26.0.0`, `@types/node` updated to `^26.6.6`).
- Upgraded major dependencies: NestJS 12 (`@nestjs/*@^12.x`), TypeORM 1.x (`^1.1.3`) with `better-sqlite3` (`12.11.1`, replacing `sqlite3`), `bitcoinjs-lib@^7.0.5` (`Uint8Array`/`bigint` API), `bitcoin-address-validation@^4.0.0`, `bs58@^6.0.0`, `TypeScript@^6.0.0`, `Jest@^30.5.2` (with `--experimental-vm-modules`), `ESLint@^10.15.0` + `@typescript-eslint/*@^8.73.0` (migrated to `eslint.config.mjs`), `@types/express@^5.0.6`, `zeromq@^6.8.0`, `axios@^1.21.1`, `discord.js@^14.28.1`, and `class-validator@^0.15.1`.
- Changed SQLite `PRAGMA synchronous` from `off` to `NORMAL` in `AppService` for WAL corruption safety.
- Configured `Dockerfile` to run as non-root `node` user and added graceful shutdown (`app.enableShutdownHooks()`) and configurable `CORS_ORIGIN` in `main.ts`.
- Optimized `StratumV1JobsService` to compute Merkle roots and witness commitments from `txid`/`hash`/`weight` without deserializing all block transactions on every template refresh, and pre-cached `merkleBranchBuffers` and payment scripts in `MiningJob`.
- Replaced `class-validator` reflection on the `mining.submit` hot path in `StratumV1Client` with synchronous `parseAndValidateMiningSubmit()`.
- Removed unused `BTCPayService` and `BraiinsService` from `AppModule` and removed unused `patch-package` `postinstall` hook.

### Fixed
- Fixed TCP buffer exhaustion DoS and concurrent message race conditions in `StratumV1Client` by enforcing a 16 KB buffer limit, sequential message queue, and JSON object type checks.
- Fixed `StratumV1Client` `resetBestDifficultyAndShares()` never triggering on block found (`result == null || result === 'SUCCESS!'`).
- Fixed `MiningSubmitMessage` and `SuggestDifficulty` validation (hex/length checks for `extraNonce2`, `ntime`, `nonce`, `versionMask`; `0x1fffe000` mask check; minimum difficulty `0.00001`).
- Isolated `MiningJob` ownership per client session (`ownerSessionId`) to prevent cross-client `jobId` reuse.
- Fixed `ExternalShareController` to require `SHARE_SUBMISSION_API_KEY` with `crypto.timingSafeEqual`, validate 80-byte headers, and reject duplicate share headers.
- Fixed `BitcoinRpcService` `getBlockTemplate()` lock fallthrough, added timeout to `waitForBlock()` and retry limit to `loadBlockTemplate()`, and added ZMQ error fallback polling.
- Fixed `StratumV1JobsService` `newMiningJob$` stream termination on RPC errors using `catchError` and ESM default interop for `merkle-lib`.
- Fixed 32-bit bitwise overflow in `StratumV1ClientStatistics.nearestPowerOfTwo()` and division-by-zero guards for `hashRate` and `getSuggestedDifficulty()`.
- Fixed `ClientController.getWorkerInfo` throwing `NotFoundException` instead of returning it with HTTP 200.
- Fixed `TelegramService` address validation to pass configured `NETWORK`.
- Fixed `MiningJob.getPaymentScript` to throw on unsupported address types instead of returning an empty script.
- Fixed `StratumV1Client` `checkDifficulty()` to use `this.write()`, bounded log-state maps, and checked `extraNonce1` uniqueness against active sessions.
- Fixed `ClientStatisticsService` chart queries dropping the sole data point when only one bucket exists.
- Removed redundant unique index on `ClientEntity` primary key columns.
