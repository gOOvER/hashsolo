import * as crypto from 'crypto';
import bs58 from 'bs58';
import * as ecc from 'tiny-secp256k1';

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
// sqrt(-3) mod P in F_p
const MINUS_3_SQRT = 0xa2d2ba93507f1df233770c2a797962cc61f6d15da14ecd47d8d27ae1cd5f852en;

function mod(a: bigint, m = P): bigint {
    const r = a % m;
    return r >= 0n ? r : r + m;
}

function modPow(base: bigint, exp: bigint, m = P): bigint {
    let result = 1n;
    let b = mod(base, m);
    let e = exp;
    while (e > 0n) {
        if (e & 1n) {
            result = (result * b) % m;
        }
        b = (b * b) % m;
        e >>= 1n;
    }
    return result;
}

function modInv(a: bigint, m = P): bigint {
    return modPow(a, m - 2n, m);
}

function modSqrt(a: bigint): bigint | null {
    const x = mod(a);
    if (x === 0n) {
        return 0n;
    }
    const r = modPow(x, (P + 1n) >> 2n);
    return mod(r * r) === x ? r : null;
}

function isSquare(a: bigint): boolean {
    const x = mod(a);
    if (x === 0n) {
        return true;
    }
    return modPow(x, (P - 1n) >> 1n) === 1n;
}

export function bigIntToBytes32BE(v: bigint): Buffer {
    const hex = mod(v).toString(16).padStart(64, '0');
    return Buffer.from(hex, 'hex');
}

export function bytes32BEToBigInt(buf: Buffer): bigint {
    return BigInt('0x' + buf.toString('hex'));
}

/**
 * BIP324 xswiftec: maps 64-byte (u, t) to an x-coordinate on secp256k1.
 */
export function xswiftec(uIn: bigint, tIn: bigint): bigint {
    let u = mod(uIn);
    let t = mod(tIn);
    if (u === 0n) u = 1n;
    if (t === 0n) t = 1n;
    const u3 = mod(u * u * u);
    if (mod(u3 + t * t + 7n) === 0n) {
        t = mod(2n * t);
    }

    const X = mod((u3 + 7n - t * t) * modInv(2n * t));
    const Y = mod((X + t) * modInv(MINUS_3_SQRT * u));

    const c1 = mod(u + 4n * Y * Y);
    if (isSquare(c1 * c1 * c1 + 7n)) {
        return c1;
    }

    const inv2 = modInv(2n);
    const xOverY = mod(X * modInv(Y));
    const c2 = mod((-xOverY - u) * inv2);
    if (isSquare(c2 * c2 * c2 + 7n)) {
        return c2;
    }

    return mod((xOverY - u) * inv2);
}

/**
 * BIP324 xswiftec_inv: given x (valid x-coord on secp256k1), u, and caseIdx in [0..7],
 * returns t such that xswiftec(u, t) === x, or null if no solution exists for this (u, caseIdx).
 */
function xswiftecInv(x: bigint, u: bigint, caseIdx: number): bigint | null {
    if (u === 0n) {
        return null;
    }

    let s: bigint;
    if ((caseIdx & 2) === 0) {
        // Case 0 or 1: x = u + 4*Y^2
        const rhs = mod(x - u);
        const y2 = mod(rhs * modInv(4n));
        if (!isSquare(y2)) {
            return null;
        }
        // Check that (-x - u)^3... wait: BIP324 ensures c1 is the first valid candidate
        const g = mod(-u * u * u - 7n);
        const x3p7 = mod(x * x * x + 7n);
        if (!isSquare(x3p7)) {
            return null;
        }
        // Wait: in caseIdx 0/1, let's compute s = -(u + x) or check via direct formula:
        // BIP324 xswiftec_inv:
        // if case & 2 == 0:
        //   if is_square((-x - u) ...): let's use exact BIP324 formulas:
        const v = mod(x - u);
        if (!isSquare(v)) {
            return null;
        }
        // Check if -(u^3 + 7) / (u - x) is square? No:
        // Let's follow BIP324 directly:
        // s = -(u^3 + 7) / (u^2 + u*x + x^2) ... wait:
        void g;
        void s;
    }

    // Exact BIP324 xswiftec_inv:
    let v: bigint;
    if ((caseIdx & 2) === 0) {
        if (isSquare(mod(-x * x * x - 7n))) {
            return null;
        }
        v = mod(x);
        s = mod(-(u * u * u + 7n) * modInv(u * u + u * v + v * v));
        // Wait: for case 0/1, v = x, and we need t from s:
        // Actually in BIP324:
        // if case & 2 == 0: v = x; s = -(u^3 + 7) / (u^2 + u*x + x^2) ? Let's check:
        // Wait: if s = -(u^3+7)/(u^2+u*v+v^2), then u^3+7 + s*(u^2+u*v+v^2) = 0 -> (u-v) vs (u^3 - v^3)...
        void s;
    }

    // Use exact BIP324 algorithm:
    // Ref: BIP324 "XElligatorSwift"
    let r: bigint;
    if ((caseIdx & 2) === 0) {
        const num = mod(-u * u * u - 7n);
        const den = mod(x - u);
        if (den === 0n) {
            return null;
        }
        s = mod(num * modInv(den));
        if (caseIdx & 1) {
            //Wait: s in case 0/1 must satisfy x = u + 4*Y^2 -> Y = (X+t)/(sqrt(-3)*u)
        }
        const tVal = modSqrt(mod(s));
        void tVal;
    }

    // Cleaner exact BIP324 formulas:
    // Let g(z) = z^3 + 7.
    if ((caseIdx & 2) === 0) {
        // c1 = x = u + 4 * Y^2 -> Y = +- sqrt((x - u) / 4)
        const Y = modSqrt(mod((x - u) * modInv(4n)));
        if (Y === null) {
            return null;
        }
        const ySigned = (caseIdx & 1) !== 0 ? mod(-Y) : Y;
        // X + t = MINUS_3_SQRT * u * ySigned
        // X = (u^3 + 7 - t^2) / (2*t)
        // => (u^3 + 7 - t^2) + 2*t^2 = 2*t * MINUS_3_SQRT * u * ySigned
        // => t^2 - 2*(MINUS_3_SQRT * u * ySigned)*t + (u^3 + 7) = 0
        const b = mod(MINUS_3_SQRT * u * ySigned);
        const disc = mod(b * b - (u * u * u + 7n));
        const sq = modSqrt(disc);
        if (sq === null) {
            return null;
        }
        const t = (caseIdx & 4) !== 0 ? mod(b + sq) : mod(b - sq);
        return xswiftec(u, t) === x ? t : null;
    } else {
        // c2 or c3: x = (-X/Y - u)/2 or (+X/Y - u)/2 => +- X/Y = 2*x + u
        // Notice: X = (u^3 + 7 - t^2)/(2t), Y = (X + t)/(MINUS_3_SQRT * u)
        // Let k = 2*x + u (or -(2*x + u) for c2)
        // X = k * Y => (X + t) = MINUS_3_SQRT * u * Y = MINUS_3_SQRT * u * X / k
        // Wait: Y = X / k -> t = MINUS_3_SQRT * u * Y - X = Y * (MINUS_3_SQRT * u - k)
        // And 2*t*X = u^3 + 7 - t^2 => 2*Y^2 * k * (MINUS_3_SQRT*u - k) + Y^2 * (MINUS_3_SQRT*u - k)^2 = u^3 + 7
        // => Y^2 * ((MINUS_3_SQRT*u)^2 - k^2) = u^3 + 7
        // => Y^2 * (-3*u^2 - k^2) = u^3 + 7
        const k = mod(2n * x + u); // works for both +- since k^2 is same, sign of Y flips!
        const denom = mod(-3n * u * u - k * k);
        if (denom === 0n) {
            return null;
        }
        const y2 = mod((u * u * u + 7n) * modInv(denom));
        const Y0 = modSqrt(y2);
        if (Y0 === null) {
            return null;
        }
        const Y = (caseIdx & 1) !== 0 ? mod(-Y0) : Y0;
        const t = mod(Y * (MINUS_3_SQRT * u - ((caseIdx & 4) !== 0 ? k : mod(-k))));
        return xswiftec(u, t) === x ? t : null;
    }
    void r;
}

/**
 * Encodes a 32-byte x-only secp256k1 public key into a 64-byte ElligatorSwift encoding.
 */
export function xelligatorswift(xOnlyPubKey: Buffer): Buffer {
    if (xOnlyPubKey.length !== 32) {
        throw new Error('xOnlyPubKey must be 32 bytes');
    }
    const x = bytes32BEToBigInt(xOnlyPubKey);
    while (true) {
        const uBytes = crypto.randomBytes(32);
        const u = mod(bytes32BEToBigInt(uBytes));
        if (u === 0n) {
            continue;
        }
        const caseIdx = crypto.randomBytes(1)[0] & 7;
        const t = xswiftecInv(x, u, caseIdx);
        if (t !== null && t !== 0n) {
            return Buffer.concat([bigIntToBytes32BE(u), bigIntToBytes32BE(t)]);
        }
    }
}

export function ellswiftDecodeXOnly(ellswift: Buffer): Buffer {
    if (ellswift.length !== 64) {
        throw new Error('ElligatorSwift key must be 64 bytes');
    }
    const u = bytes32BEToBigInt(ellswift.subarray(0, 32));
    const t = bytes32BEToBigInt(ellswift.subarray(32, 64));
    return bigIntToBytes32BE(xswiftec(u, t));
}

function taggedHash(tag: string, data: Buffer): Buffer {
    const tagHash = crypto.createHash('sha256').update(tag, 'utf8').digest();
    return crypto.createHash('sha256').update(tagHash).update(tagHash).update(data).digest();
}

/**
 * BIP324 ellswift_ecdh_xonly:
 * ellInitiator = 64B EllSwift pubkey of party A (Noise initiator)
 * ellResponder = 64B EllSwift pubkey of party B (Noise responder)
 * ellTheirs = the other party's 64B EllSwift pubkey
 * privKey = our 32B secret key
 */
export function ellswiftEcdhXonly(
    ellInitiator: Buffer,
    ellResponder: Buffer,
    ellTheirs: Buffer,
    privKey: Buffer
): Buffer {
    const xTheirs = ellswiftDecodeXOnly(ellTheirs);
    const compressedPoint = Buffer.concat([Buffer.from([0x02]), xTheirs]);
    const sharedPoint = ecc.pointMultiply(compressedPoint, privKey, true);
    if (!sharedPoint) {
        throw new Error('ECDH point multiplication failed');
    }
    const sharedX = Buffer.from(sharedPoint.subarray(1, 33));
    return taggedHash(
        'bip324_ellswift_xonly_ecdh',
        Buffer.concat([ellInitiator, ellResponder, sharedX])
    );
}

export function generateValidSecp256k1KeyPair(): { privateKey: Buffer; xOnlyPublicKey: Buffer } {
    while (true) {
        const priv = crypto.randomBytes(32);
        const val = bytes32BEToBigInt(priv);
        if (val > 0n && val < N && ecc.isPrivate(priv)) {
            const xOnly = ecc.xOnlyPointFromScalar(priv);
            if (xOnly) {
                return { privateKey: priv, xOnlyPublicKey: Buffer.from(xOnly) };
            }
        }
    }
}

/**
 * Encodes a 32-byte x-only Authority Public Key using SV2 Base58Check with [1, 0] prefix.
 */
export function encodeAuthorityPublicKey(xOnlyPubKey: Buffer): string {
    if (xOnlyPubKey.length !== 32) {
        throw new Error('Authority public key must be 32 bytes');
    }
    const payload = Buffer.concat([Buffer.from([0x01, 0x00]), xOnlyPubKey]);
    const checksum = crypto
        .createHash('sha256')
        .update(crypto.createHash('sha256').update(payload).digest())
        .digest()
        .subarray(0, 4);
    return bs58.encode(Buffer.concat([payload, checksum]));
}

export function decodeAuthorityPublicKey(encoded: string): Buffer {
    const raw = Buffer.from(bs58.decode(encoded));
    if (raw.length !== 38 || raw[0] !== 0x01 || raw[1] !== 0x00) {
        throw new Error('Invalid SV2 Authority Public Key');
    }
    const payload = raw.subarray(0, 34);
    const checksum = crypto
        .createHash('sha256')
        .update(crypto.createHash('sha256').update(payload).digest())
        .digest()
        .subarray(0, 4);
    if (!checksum.equals(raw.subarray(34, 38))) {
        throw new Error('Invalid SV2 Authority Public Key checksum');
    }
    return Buffer.from(raw.subarray(2, 34));
}
