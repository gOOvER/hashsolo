import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { Server, Socket } from 'net';
import { monitorEventLoopDelay } from 'perf_hooks';
import { Subscription } from 'rxjs';
import * as tls from 'tls';

import { StratumV1Client } from '../models/StratumV1Client';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { ExternalSharesService } from './external-shares.service';
import { NotificationService } from './notification.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { poolMetrics } from './pool-metrics.util';
import { getNonNegativeIntEnv, IpConnectionLimiter, normalizeRemoteIp } from './stratum-rate-limit.util';

interface StratumListenerState {
    port: number;
    server: Server | null;
    paused: boolean;
    tlsOptions?: tls.TlsOptions;
}

const DEFAULT_BACKPRESSURE_CHECK_INTERVAL_MS = 5000;
const DEFAULT_BACKPRESSURE_EVENT_LOOP_P95_MS = 2000;
const DEFAULT_BACKPRESSURE_EVENT_LOOP_RESUME_P95_MS = 250;
const DEFAULT_BACKPRESSURE_RSS_MB = 2500;
const DEFAULT_BACKPRESSURE_RESUME_RSS_MB = 2000;
const DEFAULT_BACKPRESSURE_HEALTHY_CHECKS = 3;
const DEFAULT_MAX_CONNECTIONS_PER_LISTENER = 10000;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 100;


@Injectable()
export class StratumV1Service implements OnModuleInit, OnModuleDestroy {

    private readonly listeners: StratumListenerState[] = [];
    private readonly activeSockets = new Set<Socket>();
    private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    private readonly ipConnectionLimiter = new IpConnectionLimiter(
        getNonNegativeIntEnv(process.env.STRATUM_MAX_CONNECTIONS_PER_IP, DEFAULT_MAX_CONNECTIONS_PER_IP),
    );
    private backpressureMonitor: NodeJS.Timeout | null = null;
    private jobKeepAliveSub: Subscription | null = null;
    private healthyBackpressureChecks = 0;

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly externalSharesService: ExternalSharesService
    ) {

    }

    async onModuleInit(): Promise<void> {

        if (process.env.NODE_APP_INSTANCE == '0' || process.env.MASTER == 'true') {
            await this.clientService.deleteAll();
        }

        if (process.env.MASTER == 'true') {
            console.log('Master process skipping Stratum socket listeners');
            return;
        }

        setTimeout(() => {
            this.startSocketServer(this.getStratumPort());
            this.startOptionalTlsServer();
        }, 1000 * 10);

        this.jobKeepAliveSub = this.stratumV1JobsService?.newMiningJob$?.subscribe({ error: () => undefined }) ?? null;
        this.startBackpressureMonitor();

    }

    onModuleDestroy(): void {
        this.jobKeepAliveSub?.unsubscribe();
        this.jobKeepAliveSub = null;
        if (this.backpressureMonitor) {
            clearInterval(this.backpressureMonitor);
            this.backpressureMonitor = null;
        }
        this.eventLoopDelay.disable();
        for (const listener of this.listeners) {
            listener.server?.close();
        }
        for (const socket of this.activeSockets) {
            try {
                socket.end();
                socket.destroy();
            } catch {
                // ignore socket errors during shutdown drain
            }
        }
        this.activeSockets.clear();
    }

    private startSocketServer(port: number, tlsOptions?: tls.TlsOptions) {
        const listener: StratumListenerState = {
            port,
            server: null,
            paused: false,
            tlsOptions
        };
        this.listeners.push(listener);
        this.listen(listener);
    }

    private startOptionalTlsServer() {
        if (process.env.STRATUM_TLS_ENABLED?.toLowerCase() !== 'true') {
            return;
        }

        const certPath = process.env.STRATUM_TLS_CERT_PATH?.trim();
        const keyPath = process.env.STRATUM_TLS_KEY_PATH?.trim();
        const caPath = process.env.STRATUM_TLS_CA_PATH?.trim();
        if (!certPath || !keyPath) {
            console.error('STRATUM_TLS_ENABLED=true but STRATUM_TLS_CERT_PATH or STRATUM_TLS_KEY_PATH is missing');
            return;
        }

        try {
            const tlsOptions: tls.TlsOptions = {
                cert: fs.readFileSync(certPath),
                key: fs.readFileSync(keyPath),
                ...(caPath ? { ca: fs.readFileSync(caPath) } : {}),
                minVersion: 'TLSv1.2'
            };
            this.startSocketServer(this.getStratumTlsPort(), tlsOptions);
        } catch (err: any) {
            console.error(`Failed to start Stratum TLS listener: ${err?.message ?? err}`);
        }
    }

    private handleClientSocket(socket: Socket) {
        const remoteIp = normalizeRemoteIp(socket.remoteAddress);
        if (!this.ipConnectionLimiter.tryAcquire(remoteIp)) {
            poolMetrics.recordConnectionRejected('ip_limit');
            console.warn(`Closing Stratum socket from ${remoteIp}: per-IP connection limit reached`);
            socket.destroy();
            return;
        }
        this.activeSockets.add(socket);

        let released = false;
        const releaseIp = () => {
            if (!released) {
                released = true;
                this.activeSockets.delete(socket);
                this.ipConnectionLimiter.release(remoteIp);
            }
        };

        // 5 min
        socket.setTimeout(1000 * 60 * 5);

        const client = new StratumV1Client(
            socket,
            this.stratumV1JobsService,
            this.bitcoinRpcService,
            this.clientService,
            this.clientStatisticsService,
            this.notificationService,
            this.blocksService,
            this.configService,
            this.addressSettingsService,
            this.externalSharesService
        );

        socket.on('close', async (hadError: boolean) => {
            releaseIp();
            if (client.extraNonceAndSessionId != null) {
                // Handle socket disconnection
                await client.destroy();
                console.log(`Client ${client.extraNonceAndSessionId} disconnected, hadError?:${hadError}`);
            }
        });

        socket.on('timeout', () => {
            console.log('socket timeout');
            socket.end();
            socket.destroy();
        });

        socket.on('error', () => undefined);
    }

    private createSocketServer(tlsOptions?: tls.TlsOptions): Server {
        const server = tlsOptions
            ? tls.createServer(tlsOptions, (socket: tls.TLSSocket) => this.handleClientSocket(socket))
            : new Server((socket: Socket) => this.handleClientSocket(socket));

        server.on('error', (err) => {
            console.error(`Server error: ${err.message}`);
        });
        if (tlsOptions) {
            server.on('tlsClientError', (err) => {
                console.warn(`Stratum TLS client error: ${err.message}`);
            });
        }
        this.configureConnectionLimit(server);

        return server;
    }

    private listen(listener: StratumListenerState) {
        if (listener.server != null) {
            return;
        }

        const server = this.createSocketServer(listener.tlsOptions);
        listener.server = server;
        listener.paused = false;

        server.listen(listener.port, () => {
            const label = listener.tlsOptions ? 'Stratum TLS' : 'Stratum';
            console.log(`${label} server is listening on port ${listener.port}`);
        });
    }

    private startBackpressureMonitor() {
        if (this.isBackpressureDisabled() || this.backpressureMonitor != null) {
            return;
        }

        this.eventLoopDelay.enable();
        this.backpressureMonitor = setInterval(() => {
            this.checkBackpressure();
        }, this.getBackpressureCheckIntervalMs());
    }

    private checkBackpressure() {
        const eventLoopP95Ms = this.getEventLoopP95Ms();
        const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const overloaded = eventLoopP95Ms >= this.getBackpressureEventLoopP95Ms()
            || rssMb >= this.getBackpressureRssMb();
        const paused = this.listeners.some(listener => listener.paused);

        if (overloaded) {
            this.healthyBackpressureChecks = 0;
            if (!paused) {
                this.pauseAccepting(eventLoopP95Ms, rssMb);
            }
            this.eventLoopDelay.reset();
            return;
        }

        if (!paused) {
            this.eventLoopDelay.reset();
            return;
        }

        const healthy = eventLoopP95Ms <= this.getBackpressureResumeEventLoopP95Ms()
            && rssMb <= this.getBackpressureResumeRssMb();
        if (!healthy) {
            this.healthyBackpressureChecks = 0;
            this.eventLoopDelay.reset();
            return;
        }

        this.healthyBackpressureChecks++;
        if (this.healthyBackpressureChecks >= this.getBackpressureHealthyChecks()) {
            this.resumeAccepting(eventLoopP95Ms, rssMb);
            this.healthyBackpressureChecks = 0;
        }

        this.eventLoopDelay.reset();
    }

    private pauseAccepting(eventLoopP95Ms: number, rssMb: number) {
        console.warn(`Pausing Stratum accepts: eventLoopP95Ms=${eventLoopP95Ms}, rssMb=${rssMb}`);
        for (const listener of this.listeners) {
            if (listener.paused || listener.server == null) {
                continue;
            }

            const server = listener.server;
            listener.server = null;
            listener.paused = true;
            server.close((error) => {
                if (error != null) {
                    console.error(`Error while pausing Stratum listener on port ${listener.port}: ${error.message}`);
                }
            });
        }
    }

    private resumeAccepting(eventLoopP95Ms: number, rssMb: number) {
        console.warn(`Resuming Stratum accepts: eventLoopP95Ms=${eventLoopP95Ms}, rssMb=${rssMb}`);
        for (const listener of this.listeners) {
            if (!listener.paused || listener.server != null) {
                continue;
            }

            this.listen(listener);
        }
    }

    private configureConnectionLimit(server: Server) {
        server.maxConnections = this.getMaxConnectionsPerListener();
        (server as Server & { dropMaxConnection: boolean }).dropMaxConnection = true;
    }

    private getEventLoopP95Ms() {
        return Math.round(this.eventLoopDelay.percentile(95) / 1e6);
    }

    private isBackpressureDisabled() {
        return process.env.STRATUM_BACKPRESSURE_ENABLED?.toLowerCase() === 'false';
    }

    private getBackpressureCheckIntervalMs() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_CHECK_INTERVAL_MS', DEFAULT_BACKPRESSURE_CHECK_INTERVAL_MS);
    }

    private getBackpressureEventLoopP95Ms() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_EVENT_LOOP_P95_MS', DEFAULT_BACKPRESSURE_EVENT_LOOP_P95_MS);
    }

    private getBackpressureResumeEventLoopP95Ms() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_EVENT_LOOP_RESUME_P95_MS', DEFAULT_BACKPRESSURE_EVENT_LOOP_RESUME_P95_MS);
    }

    private getBackpressureRssMb() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_RSS_MB', DEFAULT_BACKPRESSURE_RSS_MB);
    }

    private getBackpressureResumeRssMb() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_RESUME_RSS_MB', DEFAULT_BACKPRESSURE_RESUME_RSS_MB);
    }

    private getBackpressureHealthyChecks() {
        return this.getPositiveIntegerEnv('STRATUM_BACKPRESSURE_HEALTHY_CHECKS', DEFAULT_BACKPRESSURE_HEALTHY_CHECKS);
    }

    private getMaxConnectionsPerListener() {
        return this.getPositiveIntegerEnv('STRATUM_MAX_CONNECTIONS_PER_LISTENER', DEFAULT_MAX_CONNECTIONS_PER_LISTENER);
    }

    private getStratumPort() {
        return this.getPositiveIntegerEnv('STRATUM_PORT', 3333);
    }

    private getStratumTlsPort() {
        return this.getPositiveIntegerEnv('STRATUM_TLS_PORT', 4333);
    }

    private getPositiveIntegerEnv(key: string, fallback: number) {
        const configured = parseInt(process.env[key], 10);
        if (Number.isFinite(configured) && configured > 0) {
            return configured;
        }
        return fallback;

    }

}
