# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Added `.nvmrc` (`26`) for Node.js 26 default runtime selection.
- Added composite indexes on `ClientStatisticsEntity` (`['address', 'time']` and `['address', 'clientName', 'time']`) for chart queries.
- Added unit tests for `nearestPowerOfTwo` overflow handling, zero-delta division guards, TCP buffer overflow protection, non-positive `suggestedDifficulty` rejection, and `versionMask` validation.

### Changed
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
