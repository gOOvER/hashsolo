import {
    decodeAuthorityPublicKey,
    ellswiftDecodeXOnly,
    ellswiftEcdhXonly,
    encodeAuthorityPublicKey,
    generateValidSecp256k1KeyPair,
    xelligatorswift
} from './ellswift';
import {
    encryptSv2Frame,
    NoiseInitiatorHandshake,
    ptLenToCtLen,
    responderNoiseHandshake,
    SV2_ENCRYPTED_HEADER_SIZE
} from './noise';
import {
    decodeOpenStandardMiningChannel,
    decodeSetupConnection,
    decodeSubmitSharesStandard,
    difficultyToTargetU256LE,
    encodeNewMiningJob,
    encodeOpenStandardMiningChannelSuccess,
    encodeSetNewPrevHash,
    encodeSetupConnectionSuccess,
    encodeSubmitSharesSuccess,
    SV2_MINING_PROTOCOL,
    Sv2MessageType,
    u256LEToBigInt,
    writeStr0_255
} from './protocol';

describe('Stratum V2 Crypto & Protocol', () => {
    it('matches the official sv2-spec Authority Public Key Base58Check test vector', () => {
        const rawCaPublicKey = Buffer.from([
            118, 99, 112, 0, 151, 156, 28, 17, 175, 12, 48, 11, 205, 140, 127, 228,
            134, 16, 252, 233, 185, 193, 30, 61, 174, 227, 90, 224, 176, 138, 116, 85
        ]);
        const expected = '9bXiEd8boQVhq7WddEcERUL5tyyJVFYdU8th3HfbNXK3Yw6GRXh';
        expect(encodeAuthorityPublicKey(rawCaPublicKey)).toBe(expected);
        expect(decodeAuthorityPublicKey(expected).equals(rawCaPublicKey)).toBe(true);
    });

    it('encodes/decodes ElligatorSwift keys and computes symmetric ECDH secrets', () => {
        const alice = generateValidSecp256k1KeyPair();
        const bob = generateValidSecp256k1KeyPair();

        const ellAlice = xelligatorswift(alice.xOnlyPublicKey);
        const ellBob = xelligatorswift(bob.xOnlyPublicKey);

        expect(ellAlice.length).toBe(64);
        expect(ellBob.length).toBe(64);
        expect(ellswiftDecodeXOnly(ellAlice).equals(alice.xOnlyPublicKey)).toBe(true);
        expect(ellswiftDecodeXOnly(ellBob).equals(bob.xOnlyPublicKey)).toBe(true);

        const secretA = ellswiftEcdhXonly(ellAlice, ellBob, ellBob, alice.privateKey);
        const secretB = ellswiftEcdhXonly(ellAlice, ellBob, ellAlice, bob.privateKey);
        expect(secretA.equals(secretB)).toBe(true);
    });

    it('completes Noise_NX handshake, verifies certificate, and encrypts/decrypts SV2 frames', () => {
        const authority = generateValidSecp256k1KeyPair();
        const serverStatic = generateValidSecp256k1KeyPair();
        const initiator = new NoiseInitiatorHandshake();

        const part1 = initiator.createPart1();
        expect(part1.length).toBe(64);

        const { response, ciphers: responderCiphers } = responderNoiseHandshake(
            part1,
            authority.privateKey,
            serverStatic
        );
        expect(response.length).toBe(234);

        const initiatorCiphers = initiator.processPart2(response, authority.xOnlyPublicKey);

        const payload = encodeSetupConnectionSuccess(2, 1);
        const wire = encryptSv2Frame(
            responderCiphers.encryptor,
            0,
            Sv2MessageType.SetupConnectionSuccess,
            payload
        );

        const encHeader = wire.subarray(0, SV2_ENCRYPTED_HEADER_SIZE);
        const plainHeader = initiatorCiphers.decryptor.decryptWithAd(Buffer.alloc(0), encHeader);
        expect(plainHeader.readUInt16LE(0)).toBe(0);
        expect(plainHeader.readUInt8(2)).toBe(Sv2MessageType.SetupConnectionSuccess);
        const pldLen = plainHeader.readUIntLE(3, 3);
        expect(pldLen).toBe(payload.length);

        const ctLen = ptLenToCtLen(pldLen);
        const plainPayload = initiatorCiphers.decryptor.decryptWithAd(
            Buffer.alloc(0),
            wire.subarray(SV2_ENCRYPTED_HEADER_SIZE, SV2_ENCRYPTED_HEADER_SIZE + ctLen)
        );
        expect(plainPayload.equals(payload)).toBe(true);
    });

    it('encodes and decodes SV2 SetupConnection, OpenStandardMiningChannel, and SubmitSharesStandard', () => {
        const setupHead = Buffer.alloc(9);
        setupHead.writeUInt8(SV2_MINING_PROTOCOL, 0);
        setupHead.writeUInt16LE(2, 1);
        setupHead.writeUInt16LE(2, 3);
        setupHead.writeUInt32LE(1, 5);
        const setupPort = Buffer.alloc(2);
        setupPort.writeUInt16LE(23330, 0);
        const setupBuf = Buffer.concat([
            setupHead,
            writeStr0_255('hashsolo.goover.dev'),
            setupPort,
            writeStr0_255('Braiins'),
            writeStr0_255('S19'),
            writeStr0_255('bos-24.09'),
            writeStr0_255('rig-1')
        ]);
        const parsedSetup = decodeSetupConnection(setupBuf);
        expect(parsedSetup.protocol).toBe(0);
        expect(parsedSetup.endpointHost).toBe('hashsolo.goover.dev');
        expect(parsedSetup.endpointPort).toBe(23330);
        expect(parsedSetup.vendor).toBe('Braiins');

        const reqBuf = Buffer.alloc(4);
        reqBuf.writeUInt32LE(42, 0);
        const hrBuf = Buffer.alloc(4);
        hrBuf.writeFloatLE(1e12, 0);
        const maxTarget = Buffer.alloc(32, 0xff);
        const openBuf = Buffer.concat([
            reqBuf,
            writeStr0_255('bc1qt6wec64n3gnrhclp4vfckyvr8h27tmqswy28gc.worker1'),
            hrBuf,
            maxTarget
        ]);
        const parsedOpen = decodeOpenStandardMiningChannel(openBuf);
        expect(parsedOpen.requestId).toBe(42);
        expect(parsedOpen.userIdentity).toBe('bc1qt6wec64n3gnrhclp4vfckyvr8h27tmqswy28gc.worker1');

        const target1 = difficultyToTargetU256LE(1);
        const target2 = difficultyToTargetU256LE(2);
        expect(u256LEToBigInt(target1) > u256LEToBigInt(target2)).toBe(true);

        expect(encodeOpenStandardMiningChannelSuccess(42, 1, target1, Buffer.from('aabbccdd', 'hex'), 1).length).toBeGreaterThan(40);
        expect(encodeNewMiningJob(1, 1, null, 0x20000000, Buffer.alloc(32, 1)).length).toBe(45);
        expect(encodeSetNewPrevHash(1, 1, Buffer.alloc(32, 2), 1700000000, 0x1d00ffff).length).toBe(48);
        expect(encodeSubmitSharesSuccess(1, 5, 1, 1000n).length).toBe(20);

        const submitBuf = Buffer.alloc(24);
        submitBuf.writeUInt32LE(1, 0);
        submitBuf.writeUInt32LE(5, 4);
        submitBuf.writeUInt32LE(9, 8);
        submitBuf.writeUInt32LE(0x12345678, 12);
        submitBuf.writeUInt32LE(1700000001, 16);
        submitBuf.writeUInt32LE(0x20000000, 20);
        const parsedSubmit = decodeSubmitSharesStandard(submitBuf);
        expect(parsedSubmit.jobId).toBe(9);
        expect(parsedSubmit.nonce).toBe(0x12345678);
    });
});
