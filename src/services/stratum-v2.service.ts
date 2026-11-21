import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { Server, Socket } from 'net';
import * as path from 'path';
import * as ecc from 'tiny-secp256k1';

import { StratumV2Client } from '../models/StratumV2Client';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { encodeAuthorityPublicKey, generateValidSecp256k1KeyPair } from '../stratum-v2/ellswift';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { ExternalSharesService } from './external-shares.service';
import { NotificationService } from './notification.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';

@Injectable()
export class StratumV2Service implements OnModuleInit, OnModuleDestroy {
    private server: Server | null = null;
    private authorityPrivKey: Buffer | null = null;
    private authorityPublicKeyEncoded: string | null = null;
    private staticKeyPair: { privateKey: Buffer; xOnlyPublicKey: Buffer } | null = null;

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
    ) {}

    onModuleInit(): void {
        if (process.env.MASTER == 'true' || process.env.STRATUM_V2_ENABLED?.toLowerCase() !== 'true') {
            return;
        }

        const authority = this.loadOrCreateAuthorityKey();
        this.authorityPrivKey = authority.privateKey;
        this.authorityPublicKeyEncoded = encodeAuthorityPublicKey(authority.xOnlyPublicKey);
        this.staticKeyPair = generateValidSecp256k1KeyPair();

        const port = this.getStratumV2Port();
        setTimeout(() => {
            this.startServer(port);
        }, 1000 * 10);
    }

    onModuleDestroy(): void {
        this.server?.close();
        this.server = null;
    }

    public getAuthorityPublicKey(): string | null {
        return this.authorityPublicKeyEncoded;
    }

    private startServer(port: number) {
        if (!this.authorityPrivKey || !this.staticKeyPair) {
            return;
        }

        const server = new Server((socket: Socket) => {
            socket.setTimeout(1000 * 60 * 5);
            const client = new StratumV2Client(
                socket,
                this.authorityPrivKey!,
                this.staticKeyPair!,
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
                await client.destroy();
                console.log(`SV2 Client ${client.extraNonceAndSessionId} disconnected, hadError?:${hadError}`);
            });

            socket.on('timeout', () => {
                socket.end();
                socket.destroy();
            });

            socket.on('error', () => undefined);
        });

        server.on('error', (err) => {
            console.error(`Stratum V2 server error: ${err.message}`);
        });

        server.listen(port, () => {
            console.log(`Stratum V2 server is listening on port ${port}`);
            console.log(`Stratum V2 Authority Public Key: ${this.authorityPublicKeyEncoded}`);
        });
        this.server = server;
    }

    private loadOrCreateAuthorityKey(): { privateKey: Buffer; xOnlyPublicKey: Buffer } {
        const envKey = process.env.STRATUM_V2_AUTHORITY_PRIVKEY?.trim();
        if (envKey) {
            const priv = Buffer.from(envKey, 'hex');
            if (priv.length === 32 && ecc.isPrivate(priv)) {
                const xOnly = ecc.xOnlyPointFromScalar(priv);
                if (xOnly) {
                    return { privateKey: priv, xOnlyPublicKey: Buffer.from(xOnly) };
                }
            }
            console.warn('Invalid STRATUM_V2_AUTHORITY_PRIVKEY, falling back to persisted key');
        }

        const keyPath = process.env.STRATUM_V2_AUTHORITY_KEY_PATH?.trim() || './DB/sv2-authority.key';
        try {
            if (fs.existsSync(keyPath)) {
                const hex = fs.readFileSync(keyPath, 'utf8').trim();
                const priv = Buffer.from(hex, 'hex');
                if (priv.length === 32 && ecc.isPrivate(priv)) {
                    const xOnly = ecc.xOnlyPointFromScalar(priv);
                    if (xOnly) {
                        return { privateKey: priv, xOnlyPublicKey: Buffer.from(xOnly) };
                    }
                }
            }
        } catch {
            // ignore and generate below
        }

        const generated = generateValidSecp256k1KeyPair();
        try {
            fs.mkdirSync(path.dirname(keyPath), { recursive: true });
            fs.writeFileSync(keyPath, generated.privateKey.toString('hex'), { mode: 0o600 });
        } catch (err: any) {
            console.warn(`Could not persist SV2 authority key to ${keyPath}: ${err?.message ?? err}`);
        }
        return generated;
    }

    private getStratumV2Port(): number {
        const parsed = parseInt(process.env.STRATUM_V2_PORT ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 23330;
    }
}
