import { ConfigService } from '@nestjs/config';
import { validate } from 'bitcoin-address-validation';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import { Socket } from 'net';
import { Subscription } from 'rxjs';
import { clearInterval } from 'timers';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { ExternalSharesService } from '../services/external-shares.service';
import { NotificationService } from '../services/notification.service';
import { IJobTemplate, StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import {
    encryptSv2Frame,
    NoiseSessionCiphers,
    ptLenToCtLen,
    responderNoiseHandshake,
    SV2_ENCRYPTED_HEADER_SIZE
} from '../stratum-v2/noise';
import {
    decodeOpenStandardMiningChannel,
    decodeSetupConnection,
    decodeSubmitSharesStandard,
    difficultyToTargetU256LE,
    encodeNewMiningJob,
    encodeOpenMiningChannelError,
    encodeOpenStandardMiningChannelSuccess,
    encodeSetNewPrevHash,
    encodeSetTarget,
    encodeSetupConnectionError,
    encodeSetupConnectionSuccess,
    encodeSubmitSharesError,
    encodeSubmitSharesSuccess,
    SV2_CHANNEL_MSG_FLAG,
    SV2_MINING_PROTOCOL,
    SV2_SETUP_FLAG_REQUIRES_STANDARD_JOBS,
    SV2_SETUP_FLAG_REQUIRES_VERSION_ROLLING,
    Sv2MessageType,
    u256LEToBigInt
} from '../stratum-v2/protocol';
import { MiningJob } from './MiningJob';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';

const TRUE_DIFF_ONE = 2.695953529101131e67;
const MIN_SESSION_DIFFICULTY = 0.00001;
const MAX_HANDSHAKE_BUFFER_BYTES = 1024;
const MAX_ENCRYPTED_BUFFER_BYTES = 256 * 1024;
const DEFAULT_USER_AGENT = 'StratumV2';

export class StratumV2Client {
    private rxBuffer: Buffer = Buffer.alloc(0);
    private ciphers: NoiseSessionCiphers | null = null;
    private pendingHeader: { extensionType: number; msgType: number; payloadLen: number } | null = null;

    private connectionSetup = false;
    private channelOpened = false;
    private channelId = 1;
    private readonly groupChannelId = 1;
    private readonly extraNonce: string;
    private readonly extraNonce2 = '00000000';
    private nextJobId = 1;
    private jobs = new Map<number, MiningJob>();
    private activeJobId: number | null = null;
    private lastPrevHashHex: string | null = null;

    private address: string;
    private workerName: string;
    private userAgent = DEFAULT_USER_AGENT;
    private sessionDifficulty = 100000;
    private entity: ClientEntity;
    private creatingEntity: Promise<void>;
    private statistics: StratumV1ClientStatistics;
    private stratumSubscription: Subscription;
    private backgroundWork: NodeJS.Timeout[] = [];
    private connectionClosed = false;
    private messageQueue: Promise<void> = Promise.resolve();
    private submissionHashes = new Set<string>();

    public extraNonceAndSessionId: string;
    public sessionStart: Date;

    constructor(
        private readonly socket: Socket,
        private readonly authorityPrivKey: Buffer,
        private readonly staticKeyPair: { privateKey: Buffer; xOnlyPublicKey: Buffer },
        private readonly stratumV1JobsService: StratumV1JobsService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly notificationService: NotificationService,
        private readonly blocksService: BlocksService,
        private readonly configService: ConfigService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly externalSharesService: ExternalSharesService
    ) {
        this.extraNonce = crypto.randomBytes(4).toString('hex');
        this.extraNonceAndSessionId = this.extraNonce;
        this.sessionStart = new Date();
        this.statistics = new StratumV1ClientStatistics(this.clientStatisticsService);

        const startDiff = parseFloat(this.configService.get<string>('STRATUM_START_DIFF') ?? '');
        if (Number.isFinite(startDiff) && startDiff > 0) {
            this.sessionDifficulty = startDiff;
        }

        this.socket.on('data', (chunk: Buffer) => {
            this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
            this.enqueue(() => this.processBuffer());
        });
    }

    private enqueue(fn: () => Promise<void>) {
        this.messageQueue = this.messageQueue
            .then(fn)
            .catch((err) => {
                console.error(`SV2 client error (${this.extraNonceAndSessionId}):`, err?.message ?? err);
                this.closeSocket();
            });
    }

    private closeSocket() {
        if (!this.connectionClosed) {
            this.connectionClosed = true;
            this.socket.destroy();
        }
    }

    public async destroy() {
        this.connectionClosed = true;
        this.stratumSubscription?.unsubscribe();
        for (const timer of this.backgroundWork) {
            clearInterval(timer);
        }
        this.backgroundWork = [];
        if (this.entity) {
            await this.clientService.delete(this.extraNonceAndSessionId);
        }
    }

    private async processBuffer() {
        if (!this.ciphers) {
            if (this.rxBuffer.length > MAX_HANDSHAKE_BUFFER_BYTES) {
                this.closeSocket();
                return;
            }
            if (this.rxBuffer.length < 64) {
                return;
            }
            const initiatorEph = Buffer.from(this.rxBuffer.subarray(0, 64));
            this.rxBuffer = Buffer.from(this.rxBuffer.subarray(64));
            const { response, ciphers } = responderNoiseHandshake(
                initiatorEph,
                this.authorityPrivKey,
                this.staticKeyPair
            );
            this.ciphers = ciphers;
            this.socket.write(response);
        }

        if (this.rxBuffer.length > MAX_ENCRYPTED_BUFFER_BYTES) {
            this.closeSocket();
            return;
        }

        while (this.ciphers) {
            if (!this.pendingHeader) {
                if (this.rxBuffer.length < SV2_ENCRYPTED_HEADER_SIZE) {
                    return;
                }
                const encHeader = this.rxBuffer.subarray(0, SV2_ENCRYPTED_HEADER_SIZE);
                this.rxBuffer = Buffer.from(this.rxBuffer.subarray(SV2_ENCRYPTED_HEADER_SIZE));
                const plainHeader = this.ciphers.decryptor.decryptWithAd(Buffer.alloc(0), encHeader);
                this.pendingHeader = {
                    extensionType: plainHeader.readUInt16LE(0),
                    msgType: plainHeader.readUInt8(2),
                    payloadLen: plainHeader.readUIntLE(3, 3)
                };
            }

            const ctLen = ptLenToCtLen(this.pendingHeader.payloadLen);
            if (this.rxBuffer.length < ctLen) {
                return;
            }

            const encPayload = this.rxBuffer.subarray(0, ctLen);
            this.rxBuffer = Buffer.from(this.rxBuffer.subarray(ctLen));
            const payload = this.decryptPayloadChunks(encPayload);
            const { extensionType, msgType } = this.pendingHeader;
            this.pendingHeader = null;

            await this.handleMessage(extensionType, msgType, payload);
        }
    }

    private decryptPayloadChunks(encPayload: Buffer): Buffer {
        if (!this.ciphers) {
            return Buffer.alloc(0);
        }
        const parts: Buffer[] = [];
        for (let offset = 0; offset < encPayload.length; offset += 65535) {
            const end = Math.min(offset + 65535, encPayload.length);
            parts.push(this.ciphers.decryptor.decryptWithAd(Buffer.alloc(0), encPayload.subarray(offset, end)));
        }
        return Buffer.concat(parts);
    }

    private sendFrame(extensionType: number, msgType: number, payload: Buffer) {
        if (!this.ciphers || this.connectionClosed || this.socket.destroyed) {
            return;
        }
        const frame = encryptSv2Frame(this.ciphers.encryptor, extensionType, msgType, payload);
        this.socket.write(frame);
    }

    private async handleMessage(extensionType: number, msgType: number, payload: Buffer) {
        void extensionType;
        switch (msgType) {
            case Sv2MessageType.SetupConnection: {
                const msg = decodeSetupConnection(payload);
                if (msg.protocol !== SV2_MINING_PROTOCOL || msg.minVersion > 2 || msg.maxVersion < 2) {
                    this.sendFrame(0, Sv2MessageType.SetupConnectionError, encodeSetupConnectionError(0, 'unsupported-protocol'));
                    this.closeSocket();
                    return;
                }
                const vendorInfo = [msg.vendor, msg.hardwareVersion, msg.firmware].filter(Boolean).join(' ').trim();
                this.userAgent = vendorInfo ? `SV2:${vendorInfo}`.slice(0, 128) : DEFAULT_USER_AGENT;
                this.connectionSetup = true;
                const flags = msg.flags & (SV2_SETUP_FLAG_REQUIRES_STANDARD_JOBS | SV2_SETUP_FLAG_REQUIRES_VERSION_ROLLING);
                this.sendFrame(0, Sv2MessageType.SetupConnectionSuccess, encodeSetupConnectionSuccess(2, flags));
                return;
            }
            case Sv2MessageType.OpenStandardMiningChannel: {
                if (!this.connectionSetup || this.channelOpened) {
                    return;
                }
                const msg = decodeOpenStandardMiningChannel(payload);
                const [addr, ...workerParts] = msg.userIdentity.split('.');
                if (!addr || !validate(addr)) {
                    this.sendFrame(0, Sv2MessageType.OpenMiningChannelError, encodeOpenMiningChannelError(msg.requestId, 'invalid-user-identity'));
                    return;
                }
                this.address = addr;
                this.workerName = workerParts.join('.') || 'sv2';
                const maxTarget = u256LEToBigInt(msg.maxTarget);
                let targetBuf = difficultyToTargetU256LE(this.sessionDifficulty);
                if (u256LEToBigInt(targetBuf) > maxTarget && maxTarget > 0n) {
                    targetBuf = msg.maxTarget;
                    const diff1 = 0x00000000FFFF0000000000000000000000000000000000000000000000000000n;
                    this.sessionDifficulty = Math.max(MIN_SESSION_DIFFICULTY, Number(diff1 / maxTarget));
                }
                this.channelOpened = true;
                this.creatingEntity = this.initEntity();
                await this.creatingEntity;

                this.sendFrame(
                    0,
                    Sv2MessageType.OpenStandardMiningChannelSuccess,
                    encodeOpenStandardMiningChannelSuccess(
                        msg.requestId,
                        this.channelId,
                        targetBuf,
                        Buffer.from(this.extraNonce, 'hex'),
                        this.groupChannelId
                    )
                );

                this.subscribeJobs();
                this.startVarDiffAndHeartbeat();
                return;
            }
            case Sv2MessageType.SubmitSharesStandard: {
                if (!this.channelOpened) {
                    return;
                }
                const msg = decodeSubmitSharesStandard(payload);
                await this.handleShareSubmission(msg);
                return;
            }
            default:
                return;
        }
    }

    private async initEntity() {
        this.entity = await this.clientService.insert({
            sessionId: this.extraNonceAndSessionId,
            address: this.address,
            clientName: this.workerName,
            userAgent: this.userAgent,
            startTime: new Date(),
            bestDifficulty: 0
        });
    }

    private subscribeJobs() {
        this.stratumSubscription = this.stratumV1JobsService.newMiningJob$.subscribe(async (jobTemplate) => {
            if (!jobTemplate || this.connectionClosed) {
                return;
            }
            try {
                await this.sendJob(jobTemplate);
            } catch (err: any) {
                console.error('SV2 sendJob error:', err?.message ?? err);
            }
        });
    }

    private async sendJob(jobTemplate: IJobTemplate) {
        const jobId = this.nextJobId++;
        const networkName = this.configService.get('NETWORK') || 'mainnet';
        const network = this.getNetwork(networkName);

        const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
        const devFeePercent = parseFloat(this.configService.get('DEV_FEE_PERCENT') || '1.5');
        const payoutInformation = devFeeAddress && devFeePercent > 0
            ? [
                { address: this.address, percent: 100 - devFeePercent },
                { address: devFeeAddress, percent: devFeePercent }
            ]
            : [{ address: this.address, percent: 100 }];

        const job = new MiningJob(
            this.configService,
            network,
            jobId.toString(16),
            payoutInformation,
            jobTemplate
        );
        job.ownerSessionId = this.extraNonceAndSessionId;
        this.jobs.set(jobId, job);
        if (this.jobs.size > 30) {
            const oldest = this.jobs.keys().next().value;
            if (oldest !== undefined) {
                this.jobs.delete(oldest);
            }
        }

        const merkleRoot = job.computeMerkleRoot(this.extraNonce, this.extraNonce2);
        const nowSec = Math.floor(Date.now() / 1000);
        const ntimeStart = Math.max(nowSec, jobTemplate.block.timestamp ?? nowSec);
        const prevHashBuf = Buffer.from(jobTemplate.block.prevHash);
        const prevHashHex = prevHashBuf.toString('hex');
        const prevChanged = this.lastPrevHashHex !== prevHashHex;

        if (prevChanged) {
            // SV2 spec: first job after channel open or prevHash change starts as future job, then SetNewPrevHash activates it
            this.sendFrame(
                SV2_CHANNEL_MSG_FLAG,
                Sv2MessageType.NewMiningJob,
                encodeNewMiningJob(this.channelId, jobId, null, jobTemplate.block.version, merkleRoot)
            );
            this.sendFrame(
                SV2_CHANNEL_MSG_FLAG,
                Sv2MessageType.SetNewPrevHash,
                encodeSetNewPrevHash(this.channelId, jobId, prevHashBuf, ntimeStart, jobTemplate.block.bits)
            );
            this.lastPrevHashHex = prevHashHex;
            this.submissionHashes.clear();
        } else {
            this.sendFrame(
                SV2_CHANNEL_MSG_FLAG,
                Sv2MessageType.NewMiningJob,
                encodeNewMiningJob(this.channelId, jobId, ntimeStart, jobTemplate.block.version, merkleRoot)
            );
        }
        this.activeJobId = jobId;
    }

    private async handleShareSubmission(msg: {
        channelId: number;
        sequenceNumber: number;
        jobId: number;
        nonce: number;
        ntime: number;
        version: number;
    }) {
        const job = this.jobs.get(msg.jobId);
        if (!job) {
            this.sendFrame(SV2_CHANNEL_MSG_FLAG, Sv2MessageType.SubmitSharesError, encodeSubmitSharesError(msg.channelId, msg.sequenceNumber, 'job-not-found'));
            return;
        }
        const jobTemplate = this.stratumV1JobsService.getJobTemplateById(job.jobTemplateId);
        if (!jobTemplate) {
            this.sendFrame(SV2_CHANNEL_MSG_FLAG, Sv2MessageType.SubmitSharesError, encodeSubmitSharesError(msg.channelId, msg.sequenceNumber, 'stale-share'));
            return;
        }

        const dupKey = `${msg.jobId}:${msg.nonce}:${msg.ntime}:${msg.version}`;
        if (this.submissionHashes.has(dupKey)) {
            this.sendFrame(SV2_CHANNEL_MSG_FLAG, Sv2MessageType.SubmitSharesError, encodeSubmitSharesError(msg.channelId, msg.sequenceNumber, 'duplicate-share'));
            return;
        }
        this.submissionHashes.add(dupKey);

        const versionMask = (msg.version ^ jobTemplate.block.version) >>> 0;
        const headerBuffer = job.buildHeaderBuffer(
            jobTemplate,
            versionMask,
            msg.nonce >>> 0,
            this.extraNonce,
            this.extraNonce2,
            msg.ntime >>> 0
        );
        const hash = bitcoinjs.crypto.hash256(headerBuffer);
        const submissionDifficulty = TRUE_DIFF_ONE / Number(BigInt('0x' + Buffer.from(hash).reverse().toString('hex')));

        if (submissionDifficulty < this.sessionDifficulty) {
            this.sendFrame(SV2_CHANNEL_MSG_FLAG, Sv2MessageType.SubmitSharesError, encodeSubmitSharesError(msg.channelId, msg.sequenceNumber, 'difficulty-too-low'));
            return;
        }

        await this.statistics.addShares(this.entity, this.sessionDifficulty);
        const now = new Date();
        if (submissionDifficulty > this.entity.bestDifficulty) {
            this.entity.bestDifficulty = submissionDifficulty;
            await this.clientService.updateBestDifficultyIfHigher(
                this.extraNonceAndSessionId,
                submissionDifficulty
            );
            const settings = await this.addressSettingsService.getSettings(this.address, true);
            if (submissionDifficulty > settings.bestDifficulty) {
                await this.addressSettingsService.updateBestDifficulty(this.address, submissionDifficulty, this.workerName);
            }
        }
        void this.clientService.heartbeat(
            this.entity.address,
            this.entity.clientName,
            this.entity.sessionId,
            this.statistics.hashRate,
            now
        );

        const blockTarget = bitcoinjs.Block.calculateTarget(jobTemplate.block.bits);
        const blockHashVal = BigInt('0x' + Buffer.from(hash).reverse().toString('hex'));
        const targetVal = BigInt('0x' + Buffer.from(blockTarget).reverse().toString('hex'));
        if (blockHashVal <= targetVal) {
            const fullBlock = job.copyAndUpdateBlock(
                jobTemplate,
                versionMask,
                msg.nonce >>> 0,
                this.extraNonce,
                this.extraNonce2,
                msg.ntime >>> 0
            );
            const result = await this.bitcoinRpcService.SUBMIT_BLOCK(fullBlock.toHex());
            await this.blocksService.save({
                height: jobTemplate.blockData.height,
                minerAddress: this.address,
                worker: this.workerName,
                sessionId: this.extraNonceAndSessionId,
                blockData: JSON.stringify(result)
            });
            await this.notificationService.notifySubscribersBlockFound(
                this.address,
                jobTemplate.blockData.height,
                fullBlock,
                result
            );
        }

        this.sendFrame(
            SV2_CHANNEL_MSG_FLAG,
            Sv2MessageType.SubmitSharesSuccess,
            encodeSubmitSharesSuccess(msg.channelId, msg.sequenceNumber, 1, BigInt(Math.max(1, Math.round(this.sessionDifficulty))))
        );
    }

    private startVarDiffAndHeartbeat() {
        const timer = setInterval(async () => {
            if (this.connectionClosed || !this.entity) {
                return;
            }
            const suggested = this.statistics.getSuggestedDifficulty(this.sessionDifficulty);
            if (suggested != null && suggested !== this.sessionDifficulty) {
                this.sessionDifficulty = suggested;
                this.sendFrame(
                    SV2_CHANNEL_MSG_FLAG,
                    Sv2MessageType.SetTarget,
                    encodeSetTarget(this.channelId, difficultyToTargetU256LE(suggested))
                );
            }
            await this.clientService.heartbeat(
                this.entity.address,
                this.entity.clientName,
                this.entity.sessionId,
                this.statistics.hashRate,
                new Date()
            );
        }, 15000);
        this.backgroundWork.push(timer);
    }

    private getNetwork(networkName: string): bitcoinjs.networks.Network {
        if (networkName === 'testnet' || networkName === 'testnet4' || networkName === 'signet') {
            return bitcoinjs.networks.testnet;
        }
        if (networkName === 'regtest') {
            return bitcoinjs.networks.regtest;
        }
        return bitcoinjs.networks.bitcoin;
    }
}
