export enum Sv2MessageType {
    SetupConnection = 0x00,
    SetupConnectionSuccess = 0x01,
    SetupConnectionError = 0x02,
    OpenStandardMiningChannel = 0x10,
    OpenStandardMiningChannelSuccess = 0x11,
    OpenMiningChannelError = 0x12,
    NewMiningJob = 0x15,
    SubmitSharesStandard = 0x1a,
    SubmitSharesSuccess = 0x1c,
    SubmitSharesError = 0x1d,
    SetNewPrevHash = 0x20,
    SetTarget = 0x21
}

export const SV2_MINING_PROTOCOL = 0;
export const SV2_SETUP_FLAG_REQUIRES_STANDARD_JOBS = 1 << 0;
export const SV2_SETUP_FLAG_REQUIRES_VERSION_ROLLING = 1 << 2;
export const SV2_CHANNEL_MSG_FLAG = 0x8000;

export interface SetupConnectionMsg {
    protocol: number;
    minVersion: number;
    maxVersion: number;
    flags: number;
    endpointHost: string;
    endpointPort: number;
    vendor: string;
    hardwareVersion: string;
    firmware: string;
    deviceId: string;
}

export interface OpenStandardMiningChannelMsg {
    requestId: number;
    userIdentity: string;
    nominalHashRate: number;
    maxTarget: Buffer; // 32 bytes LE U256
}

export interface SubmitSharesStandardMsg {
    channelId: number;
    sequenceNumber: number;
    jobId: number;
    nonce: number;
    ntime: number;
    version: number;
}

class Sv2Reader {
    private offset = 0;

    constructor(private readonly buf: Buffer) {}

    public readU8(): number {
        const val = this.buf.readUInt8(this.offset);
        this.offset += 1;
        return val;
    }

    public readU16(): number {
        const val = this.buf.readUInt16LE(this.offset);
        this.offset += 2;
        return val;
    }

    public readU32(): number {
        const val = this.buf.readUInt32LE(this.offset);
        this.offset += 4;
        return val;
    }

    public readF32(): number {
        const val = this.buf.readFloatLE(this.offset);
        this.offset += 4;
        return val;
    }

    public readU256(): Buffer {
        const val = Buffer.from(this.buf.subarray(this.offset, this.offset + 32));
        if (val.length !== 32) {
            throw new Error('Unexpected EOF reading U256');
        }
        this.offset += 32;
        return val;
    }

    public readStr0_255(): string {
        const len = this.readU8();
        const slice = this.buf.subarray(this.offset, this.offset + len);
        if (slice.length !== len) {
            throw new Error('Unexpected EOF reading STR0_255');
        }
        this.offset += len;
        return slice.toString('utf8');
    }
}

export function writeStr0_255(value: string): Buffer {
    const strBuf = Buffer.from(value, 'utf8').subarray(0, 255);
    return Buffer.concat([Buffer.from([strBuf.length]), strBuf]);
}

export function writeB0_32(value: Buffer): Buffer {
    const slice = value.subarray(0, 32);
    return Buffer.concat([Buffer.from([slice.length]), slice]);
}

export function decodeSetupConnection(payload: Buffer): SetupConnectionMsg {
    const r = new Sv2Reader(payload);
    return {
        protocol: r.readU8(),
        minVersion: r.readU16(),
        maxVersion: r.readU16(),
        flags: r.readU32(),
        endpointHost: r.readStr0_255(),
        endpointPort: r.readU16(),
        vendor: r.readStr0_255(),
        hardwareVersion: r.readStr0_255(),
        firmware: r.readStr0_255(),
        deviceId: r.readStr0_255()
    };
}

export function encodeSetupConnectionSuccess(usedVersion: number, flags: number): Buffer {
    const buf = Buffer.alloc(6);
    buf.writeUInt16LE(usedVersion, 0);
    buf.writeUInt32LE(flags >>> 0, 2);
    return buf;
}

export function encodeSetupConnectionError(flags: number, errorCode: string): Buffer {
    const flagsBuf = Buffer.alloc(4);
    flagsBuf.writeUInt32LE(flags >>> 0, 0);
    return Buffer.concat([flagsBuf, writeStr0_255(errorCode)]);
}

export function decodeOpenStandardMiningChannel(payload: Buffer): OpenStandardMiningChannelMsg {
    const r = new Sv2Reader(payload);
    return {
        requestId: r.readU32(),
        userIdentity: r.readStr0_255(),
        nominalHashRate: r.readF32(),
        maxTarget: r.readU256()
    };
}

export function encodeOpenStandardMiningChannelSuccess(
    requestId: number,
    channelId: number,
    targetU256LE: Buffer,
    extranoncePrefix: Buffer,
    groupChannelId: number
): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(requestId >>> 0, 0);
    head.writeUInt32LE(channelId >>> 0, 4);
    const groupBuf = Buffer.alloc(4);
    groupBuf.writeUInt32LE(groupChannelId >>> 0, 0);
    return Buffer.concat([head, targetU256LE, writeB0_32(extranoncePrefix), groupBuf]);
}

export function encodeOpenMiningChannelError(requestId: number, errorCode: string): Buffer {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(requestId >>> 0, 0);
    return Buffer.concat([buf, writeStr0_255(errorCode)]);
}

export function encodeNewMiningJob(
    channelId: number,
    jobId: number,
    ntimeStart: number | null,
    version: number,
    merkleRoot: Buffer
): Buffer {
    const parts: Buffer[] = [];
    const header = Buffer.alloc(8);
    header.writeUInt32LE(channelId >>> 0, 0);
    header.writeUInt32LE(jobId >>> 0, 4);
    parts.push(header);

    // OPTION[U32]: presence byte (0 or 1) + U32 LE if present
    if (ntimeStart == null) {
        parts.push(Buffer.from([0]));
    } else {
        const opt = Buffer.alloc(5);
        opt.writeUInt8(1, 0);
        opt.writeUInt32LE(ntimeStart >>> 0, 1);
        parts.push(opt);
    }

    const verBuf = Buffer.alloc(4);
    verBuf.writeUInt32LE(version >>> 0, 0);
    parts.push(verBuf);
    parts.push(merkleRoot); // 32 bytes
    return Buffer.concat(parts);
}

export function encodeSetNewPrevHash(
    channelId: number,
    jobId: number,
    prevHash: Buffer,
    minNtime: number,
    nbits: number
): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(channelId >>> 0, 0);
    head.writeUInt32LE(jobId >>> 0, 4);
    const tail = Buffer.alloc(8);
    tail.writeUInt32LE(minNtime >>> 0, 0);
    tail.writeUInt32LE(nbits >>> 0, 4);
    return Buffer.concat([head, prevHash, tail]);
}

export function encodeSetTarget(channelId: number, targetU256LE: Buffer): Buffer {
    const ch = Buffer.alloc(4);
    ch.writeUInt32LE(channelId >>> 0, 0);
    return Buffer.concat([ch, targetU256LE]);
}

export function decodeSubmitSharesStandard(payload: Buffer): SubmitSharesStandardMsg {
    const r = new Sv2Reader(payload);
    return {
        channelId: r.readU32(),
        sequenceNumber: r.readU32(),
        jobId: r.readU32(),
        nonce: r.readU32(),
        ntime: r.readU32(),
        version: r.readU32()
    };
}

export function encodeSubmitSharesSuccess(
    channelId: number,
    lastSequenceNumber: number,
    newSubmitsAcceptedCount: number,
    newSharesSum: bigint
): Buffer {
    const buf = Buffer.alloc(20);
    buf.writeUInt32LE(channelId >>> 0, 0);
    buf.writeUInt32LE(lastSequenceNumber >>> 0, 4);
    buf.writeUInt32LE(newSubmitsAcceptedCount >>> 0, 8);
    buf.writeBigUInt64LE(newSharesSum, 12);
    return buf;
}

export function encodeSubmitSharesError(
    channelId: number,
    sequenceNumber: number,
    errorCode: string
): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(channelId >>> 0, 0);
    buf.writeUInt32LE(sequenceNumber >>> 0, 4);
    return Buffer.concat([buf, writeStr0_255(errorCode)]);
}

const DIFF_ONE_TARGET = 0x00000000FFFF0000000000000000000000000000000000000000000000000000n;
const MAX_U256 = (1n << 256n) - 1n;

export function difficultyToTargetU256LE(difficulty: number): Buffer {
    if (!Number.isFinite(difficulty) || difficulty <= 0) {
        difficulty = 1;
    }
    const scale = 1_000_000n;
    const scaledDiff = BigInt(Math.max(1, Math.round(difficulty * Number(scale))));
    let target = (DIFF_ONE_TARGET * scale) / scaledDiff;
    if (target > MAX_U256) {
        target = MAX_U256;
    }
    const hex = target.toString(16).padStart(64, '0');
    // SV2 U256 is little-endian 32 bytes
    return Buffer.from(hex, 'hex').reverse();
}

export function u256LEToBigInt(buf: Buffer): bigint {
    return BigInt('0x' + Buffer.from(buf).reverse().toString('hex'));
}
