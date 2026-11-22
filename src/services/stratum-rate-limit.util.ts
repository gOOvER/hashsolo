import * as crypto from 'crypto';

/**
 * Normalizes socket/HTTP remote IP addresses (strips IPv4-mapped IPv6 `::ffff:` prefix).
 */
export function normalizeRemoteIp(remoteAddress?: string | null): string {
    const raw = (remoteAddress ?? '').trim();
    if (!raw) {
        return 'unknown';
    }
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * Parses a non-negative integer environment variable (0 disables the limit).
 */
export function getNonNegativeIntEnv(rawValue: string | undefined, fallback: number): number {
    const parsed = parseInt(rawValue ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Tracks concurrent TCP connections per client IP address.
 */
export class IpConnectionLimiter {
    private readonly activeByIp = new Map<string, number>();

    constructor(private readonly maxConnectionsPerIp: number) {}

    public tryAcquire(remoteAddress?: string | null): boolean {
        if (this.maxConnectionsPerIp <= 0) {
            return true;
        }
        const ip = normalizeRemoteIp(remoteAddress);
        const current = this.activeByIp.get(ip) ?? 0;
        if (current >= this.maxConnectionsPerIp) {
            return false;
        }
        this.activeByIp.set(ip, current + 1);
        return true;
    }

    public release(remoteAddress?: string | null): void {
        if (this.maxConnectionsPerIp <= 0) {
            return;
        }
        const ip = normalizeRemoteIp(remoteAddress);
        const current = this.activeByIp.get(ip) ?? 0;
        if (current <= 1) {
            this.activeByIp.delete(ip);
            return;
        }
        this.activeByIp.set(ip, current - 1);
    }

    public getActiveCount(remoteAddress?: string | null): number {
        return this.activeByIp.get(normalizeRemoteIp(remoteAddress)) ?? 0;
    }
}

interface RateLimitBucket {
    count: number;
    resetAtMs: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAtMs: number;
}

/**
 * Bounded in-memory fixed-window HTTP rate limiter per client IP.
 */
export class SlidingWindowRateLimiter {
    private readonly buckets = new Map<string, RateLimitBucket>();

    constructor(
        private readonly maxRequests: number,
        private readonly windowMs: number,
        private readonly maxTrackedIps = 10_000,
    ) {}

    public consume(remoteAddress?: string | null, now = Date.now()): RateLimitResult {
        if (this.maxRequests <= 0 || this.windowMs <= 0) {
            return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetAtMs: now };
        }

        const ip = normalizeRemoteIp(remoteAddress);
        let bucket = this.buckets.get(ip);

        if (!bucket || now >= bucket.resetAtMs) {
            if (!bucket && this.buckets.size >= this.maxTrackedIps) {
                this.pruneExpired(now);
                if (this.buckets.size >= this.maxTrackedIps) {
                    const oldestKey = this.buckets.keys().next().value;
                    if (oldestKey !== undefined) {
                        this.buckets.delete(oldestKey);
                    }
                }
            }
            bucket = { count: 1, resetAtMs: now + this.windowMs };
            this.buckets.set(ip, bucket);
            return {
                allowed: true,
                remaining: Math.max(0, this.maxRequests - 1),
                resetAtMs: bucket.resetAtMs,
            };
        }

        bucket.count += 1;
        const allowed = bucket.count <= this.maxRequests;
        return {
            allowed,
            remaining: Math.max(0, this.maxRequests - bucket.count),
            resetAtMs: bucket.resetAtMs,
        };
    }

    private pruneExpired(now: number): void {
        for (const [key, entry] of this.buckets.entries()) {
            if (now >= entry.resetAtMs) {
                this.buckets.delete(key);
            }
        }
    }
}

/**
 * Validates optional Bearer token authentication for `/metrics` and `/api/metrics`.
 * When `configuredToken` is empty/undefined, metrics remain accessible without auth.
 */
export function isAuthorizedMetricsRequest(
    authHeader: string | undefined,
    configuredToken: string | undefined,
): boolean {
    const expected = configuredToken?.trim();
    if (!expected) {
        return true;
    }

    const header = authHeader?.trim();
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
        return false;
    }

    const provided = header.slice(7).trim();
    if (!provided) {
        return false;
    }

    const expectedDigest = crypto.createHash('sha256').update(expected).digest();
    const providedDigest = crypto.createHash('sha256').update(provided).digest();
    return crypto.timingSafeEqual(expectedDigest, providedDigest);
}
