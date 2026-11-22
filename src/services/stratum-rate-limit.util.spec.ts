import {
    getNonNegativeIntEnv,
    IpConnectionLimiter,
    isAuthorizedMetricsRequest,
    normalizeRemoteIp,
    SlidingWindowRateLimiter,
} from './stratum-rate-limit.util';

describe('stratum-rate-limit.util', () => {
    it('normalizes IPv4-mapped IPv6 addresses and empty values', () => {
        expect(normalizeRemoteIp('::ffff:192.168.1.50')).toBe('192.168.1.50');
        expect(normalizeRemoteIp('10.0.0.5')).toBe('10.0.0.5');
        expect(normalizeRemoteIp(undefined)).toBe('unknown');
    });

    it('parses non-negative integer env values with 0 allowed', () => {
        expect(getNonNegativeIntEnv('0', 100)).toBe(0);
        expect(getNonNegativeIntEnv('25', 100)).toBe(25);
        expect(getNonNegativeIntEnv('-5', 100)).toBe(100);
        expect(getNonNegativeIntEnv(undefined, 100)).toBe(100);
    });

    it('enforces per-IP concurrent connection limits and releases cleanly', () => {
        const limiter = new IpConnectionLimiter(2);

        expect(limiter.tryAcquire('::ffff:1.2.3.4')).toBe(true);
        expect(limiter.tryAcquire('1.2.3.4')).toBe(true);
        expect(limiter.tryAcquire('1.2.3.4')).toBe(false);
        expect(limiter.getActiveCount('1.2.3.4')).toBe(2);

        limiter.release('::ffff:1.2.3.4');
        expect(limiter.getActiveCount('1.2.3.4')).toBe(1);
        expect(limiter.tryAcquire('1.2.3.4')).toBe(true);

        limiter.release('1.2.3.4');
        limiter.release('1.2.3.4');
        limiter.release('1.2.3.4');
        expect(limiter.getActiveCount('1.2.3.4')).toBe(0);
    });

    it('disables per-IP connection limit when configured to 0', () => {
        const limiter = new IpConnectionLimiter(0);
        expect(limiter.tryAcquire('1.2.3.4')).toBe(true);
        expect(limiter.tryAcquire('1.2.3.4')).toBe(true);
    });

    it('enforces HTTP sliding-window rate limit and resets after window', () => {
        const limiter = new SlidingWindowRateLimiter(2, 1000, 10);

        expect(limiter.consume('1.2.3.4', 1000).allowed).toBe(true);
        expect(limiter.consume('1.2.3.4', 1200).allowed).toBe(true);
        expect(limiter.consume('1.2.3.4', 1500).allowed).toBe(false);
        expect(limiter.consume('1.2.3.4', 2001).allowed).toBe(true);
    });

    it('validates optional metrics bearer token with timing-safe comparison', () => {
        expect(isAuthorizedMetricsRequest(undefined, undefined)).toBe(true);
        expect(isAuthorizedMetricsRequest(undefined, '')).toBe(true);
        expect(isAuthorizedMetricsRequest(undefined, 'secret-token')).toBe(false);
        expect(isAuthorizedMetricsRequest('Bearer wrong', 'secret-token')).toBe(false);
        expect(isAuthorizedMetricsRequest('Bearer secret-token', 'secret-token')).toBe(true);
    });
});
