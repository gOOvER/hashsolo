import * as crypto from 'crypto';
import * as ecc from 'tiny-secp256k1';
import {
    ellswiftDecodeXOnly,
    ellswiftEcdhXonly,
    generateValidSecp256k1KeyPair,
    xelligatorswift
} from './ellswift';

const NOISE_PROTOCOL_NAME = 'Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256';
export const MAX_NOISE_CT_LEN = 65535;
export const NOISE_MAC_LEN = 16;
export const MAX_NOISE_PT_LEN = MAX_NOISE_CT_LEN - NOISE_MAC_LEN;
export const SV2_FRAME_HEADER_SIZE = 6;
export const SV2_ENCRYPTED_HEADER_SIZE = SV2_FRAME_HEADER_SIZE + NOISE_MAC_LEN; // 22 bytes

function sha256(data: Buffer): Buffer {
    return crypto.createHash('sha256').update(data).digest();
}

function hkdf2(chainingKey: Buffer, inputKeyMaterial: Buffer): [Buffer, Buffer] {
    const out = Buffer.from(
        crypto.hkdfSync('sha256', inputKeyMaterial, chainingKey, Buffer.alloc(0), 64)
    );
    return [Buffer.from(out.subarray(0, 32)), Buffer.from(out.subarray(32, 64))];
}

function noiseNonce(n: number): Buffer {
    const nonce = Buffer.alloc(12, 0);
    nonce.writeBigUInt64LE(BigInt(n), 4);
    return nonce;
}

export class NoiseCipherState {
    private key: Buffer | null = null;
    private n = 0;

    public initializeKey(key: Buffer | null) {
        this.key = key ? Buffer.from(key) : null;
        this.n = 0;
    }

    public hasKey(): boolean {
        return this.key != null;
    }

    public encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
        if (!this.key) {
            return Buffer.from(plaintext);
        }
        const cipher = crypto.createCipheriv('chacha20-poly1305', this.key, noiseNonce(this.n), {
            authTagLength: NOISE_MAC_LEN
        });
        if (ad.length > 0) {
            cipher.setAAD(ad);
        }
        const ct = cipher.update(plaintext);
        const final = cipher.final();
        const tag = cipher.getAuthTag();
        this.n++;
        return Buffer.concat([ct, final, tag]);
    }

    public decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer {
        if (!this.key) {
            return Buffer.from(ciphertext);
        }
        if (ciphertext.length < NOISE_MAC_LEN) {
            throw new Error('Ciphertext shorter than AEAD tag');
        }
        const data = ciphertext.subarray(0, ciphertext.length - NOISE_MAC_LEN);
        const tag = ciphertext.subarray(ciphertext.length - NOISE_MAC_LEN);
        const decipher = crypto.createDecipheriv('chacha20-poly1305', this.key, noiseNonce(this.n), {
            authTagLength: NOISE_MAC_LEN
        });
        if (ad.length > 0) {
            decipher.setAAD(ad);
        }
        decipher.setAuthTag(tag);
        const pt = decipher.update(data);
        const final = decipher.final();
        this.n++;
        return Buffer.concat([pt, final]);
    }
}

export function buildSignatureNoiseMessage(
    serverStaticXOnlyPubKey: Buffer,
    authorityPrivKey: Buffer,
    validFrom: number,
    notValidAfter: number
): Buffer {
    const versionBuf = Buffer.alloc(2);
    versionBuf.writeUInt16LE(0, 0);
    const validFromBuf = Buffer.alloc(4);
    validFromBuf.writeUInt32LE(validFrom >>> 0, 0);
    const notValidAfterBuf = Buffer.alloc(4);
    notValidAfterBuf.writeUInt32LE(notValidAfter >>> 0, 0);

    const signedFields = Buffer.concat([
        versionBuf,
        validFromBuf,
        notValidAfterBuf,
        serverStaticXOnlyPubKey
    ]);
    const digest = sha256(signedFields);
    const sig = Buffer.from(ecc.signSchnorr(digest, authorityPrivKey));
    return Buffer.concat([versionBuf, validFromBuf, notValidAfterBuf, sig]);
}

export function verifySignatureNoiseMessage(
    msg: Buffer,
    serverStaticXOnlyPubKey: Buffer,
    authorityXOnlyPubKey: Buffer,
    nowSeconds: number
): boolean {
    if (msg.length !== 74) {
        return false;
    }
    const version = msg.readUInt16LE(0);
    const validFrom = msg.readUInt32LE(2);
    const notValidAfter = msg.readUInt32LE(6);
    if (version !== 0 || nowSeconds < validFrom || nowSeconds > notValidAfter) {
        return false;
    }
    const signedFields = Buffer.concat([msg.subarray(0, 10), serverStaticXOnlyPubKey]);
    const digest = sha256(signedFields);
    return ecc.verifySchnorr(digest, authorityXOnlyPubKey, msg.subarray(10, 74));
}

class NoiseHandshakeState {
    public ck: Buffer;
    public h: Buffer;
    public cipher = new NoiseCipherState();

    constructor() {
        const nameBuf = Buffer.from(NOISE_PROTOCOL_NAME, 'ascii');
        // protocolName is 45 bytes (> 32), so h = SHA256(protocolName)
        const initial = nameBuf.length <= 32 ? Buffer.concat([nameBuf, Buffer.alloc(32 - nameBuf.length)]) : sha256(nameBuf);
        this.ck = initial;
        this.h = sha256(initial);
    }

    public mixHash(data: Buffer) {
        this.h = sha256(Buffer.concat([this.h, data]));
    }

    public mixKey(ikm: Buffer) {
        const [newCk, tempK] = hkdf2(this.ck, ikm);
        this.ck = newCk;
        this.cipher.initializeKey(tempK);
    }

    public encryptAndHash(plaintext: Buffer): Buffer {
        const ct = this.cipher.encryptWithAd(this.h, plaintext);
        this.mixHash(ct);
        return ct;
    }

    public decryptAndHash(ciphertext: Buffer): Buffer {
        const pt = this.cipher.decryptWithAd(this.h, ciphertext);
        this.mixHash(ciphertext);
        return pt;
    }

    public split(): [NoiseCipherState, NoiseCipherState] {
        const [k1, k2] = hkdf2(this.ck, Buffer.alloc(0));
        const c1 = new NoiseCipherState();
        const c2 = new NoiseCipherState();
        c1.initializeKey(k1);
        c2.initializeKey(k2);
        return [c1, c2];
    }
}

export interface NoiseSessionCiphers {
    decryptor: NoiseCipherState;
    encryptor: NoiseCipherState;
}

/**
 * Responder side of Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256.
 * Step 1: receives 64-byte ephemeral EllSwift pubkey from initiator.
 * Step 2: returns 234-byte handshake response (64 + 80 + 90) and session ciphers.
 */
export function responderNoiseHandshake(
    initiatorEphemeralEllSwift: Buffer,
    authorityPrivKey: Buffer,
    staticKeyPair = generateValidSecp256k1KeyPair()
): { response: Buffer; ciphers: NoiseSessionCiphers } {
    if (initiatorEphemeralEllSwift.length !== 64) {
        throw new Error('Expected 64-byte initiator ephemeral EllSwift key');
    }

    const hs = new NoiseHandshakeState();
    // Part 1: <- e
    hs.mixHash(initiatorEphemeralEllSwift);
    hs.decryptAndHash(Buffer.alloc(0));

    // Part 2: -> e, ee, s, es + SIGNATURE_NOISE_MESSAGE
    const eph = generateValidSecp256k1KeyPair();
    const ephEllSwift = xelligatorswift(eph.xOnlyPublicKey);
    hs.mixHash(ephEllSwift);

    const ecdhEe = ellswiftEcdhXonly(
        initiatorEphemeralEllSwift,
        ephEllSwift,
        initiatorEphemeralEllSwift,
        eph.privateKey
    );
    hs.mixKey(ecdhEe);

    const staticEllSwift = xelligatorswift(staticKeyPair.xOnlyPublicKey);
    const encStatic = hs.encryptAndHash(staticEllSwift); // 64 + 16 = 80 bytes

    const ecdhEs = ellswiftEcdhXonly(
        initiatorEphemeralEllSwift,
        staticEllSwift,
        initiatorEphemeralEllSwift,
        staticKeyPair.privateKey
    );
    hs.mixKey(ecdhEs);

    const now = Math.floor(Date.now() / 1000);
    const sigMsg = buildSignatureNoiseMessage(
        staticKeyPair.xOnlyPublicKey,
        authorityPrivKey,
        Math.max(0, now - 60),
        now + 365 * 24 * 60 * 60
    );
    const encSig = hs.encryptAndHash(sigMsg); // 74 + 16 = 90 bytes

    const [c1, c2] = hs.split();
    return {
        response: Buffer.concat([ephEllSwift, encStatic, encSig]),
        ciphers: {
            decryptor: c1, // initiator -> responder
            encryptor: c2  // responder -> initiator
        }
    };
}

/**
 * Initiator side of Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256 (used in tests).
 */
export class NoiseInitiatorHandshake {
    private readonly hs = new NoiseHandshakeState();
    private readonly eph = generateValidSecp256k1KeyPair();
    public readonly ephEllSwift: Buffer;

    constructor() {
        this.ephEllSwift = xelligatorswift(this.eph.xOnlyPublicKey);
    }

    public createPart1(): Buffer {
        this.hs.mixHash(this.ephEllSwift);
        const emptyCt = this.hs.encryptAndHash(Buffer.alloc(0));
        return Buffer.concat([this.ephEllSwift, emptyCt]);
    }

    public processPart2(response: Buffer, authorityXOnlyPubKey: Buffer): NoiseSessionCiphers {
        if (response.length !== 234) {
            throw new Error(`Expected 234-byte handshake part 2, got ${response.length}`);
        }
        const respEphEllSwift = response.subarray(0, 64);
        const encStatic = response.subarray(64, 144);
        const encSig = response.subarray(144, 234);

        this.hs.mixHash(respEphEllSwift);
        const ecdhEe = ellswiftEcdhXonly(
            this.ephEllSwift,
            respEphEllSwift,
            respEphEllSwift,
            this.eph.privateKey
        );
        this.hs.mixKey(ecdhEe);

        const respStaticEllSwift = this.hs.decryptAndHash(encStatic);
        const ecdhEs = ellswiftEcdhXonly(
            this.ephEllSwift,
            respStaticEllSwift,
            respStaticEllSwift,
            this.eph.privateKey
        );
        this.hs.mixKey(ecdhEs);

        const sigMsg = this.hs.decryptAndHash(encSig);
        const respStaticXOnly = ellswiftDecodeXOnly(respStaticEllSwift);
        const now = Math.floor(Date.now() / 1000);
        if (!verifySignatureNoiseMessage(sigMsg, respStaticXOnly, authorityXOnlyPubKey, now)) {
            throw new Error('Server certificate signature verification failed');
        }

        const [c1, c2] = this.hs.split();
        return {
            encryptor: c1,
            decryptor: c2
        };
    }
}

export function ptLenToCtLen(ptLen: number): number {
    if (ptLen === 0) {
        return NOISE_MAC_LEN;
    }
    let remainder = ptLen % MAX_NOISE_PT_LEN;
    if (remainder > 0) {
        remainder += NOISE_MAC_LEN;
    }
    return Math.floor(ptLen / MAX_NOISE_PT_LEN) * MAX_NOISE_CT_LEN + remainder;
}

export function encryptSv2Frame(
    encryptor: NoiseCipherState,
    extensionType: number,
    msgType: number,
    payload: Buffer
): Buffer {
    const header = Buffer.alloc(SV2_FRAME_HEADER_SIZE);
    header.writeUInt16LE(extensionType & 0xffff, 0);
    header.writeUInt8(msgType & 0xff, 2);
    header.writeUIntLE(payload.length, 3, 3);

    const encHeader = encryptor.encryptWithAd(Buffer.alloc(0), header);
    if (payload.length === 0) {
        return Buffer.concat([encHeader, encryptor.encryptWithAd(Buffer.alloc(0), Buffer.alloc(0))]);
    }

    const chunks: Buffer[] = [encHeader];
    for (let offset = 0; offset < payload.length; offset += MAX_NOISE_PT_LEN) {
        const chunk = payload.subarray(offset, Math.min(offset + MAX_NOISE_PT_LEN, payload.length));
        chunks.push(encryptor.encryptWithAd(Buffer.alloc(0), chunk));
    }
    return Buffer.concat(chunks);
}
