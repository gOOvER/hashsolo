import { Subject } from 'rxjs';

export type ShareRejectionReason = 'stale' | 'duplicate' | 'low_diff' | 'invalid';
export type ConnectionRejectionReason = 'ip_limit' | 'invalid_messages' | 'user_agent';
export type PoolStreamEventType = 'share' | 'block' | 'best_diff';

export interface PoolStreamEvent {
    type: PoolStreamEventType;
    timestamp: string;
    data: Record<string, unknown>;
}

export interface PoolMetricsSnapshot {
    sharesAcceptedTotal: number;
    sharesRejected: Record<ShareRejectionReason, number>;
    connectionsRejected: Record<ConnectionRejectionReason, number>;
    templateAgeSeconds: number;
    zmqLastMessageSeconds: number;
}

class PoolMetricsRegistry {
    private sharesAcceptedTotal = 0;
    private readonly sharesRejected: Record<ShareRejectionReason, number> = {
        stale: 0,
        duplicate: 0,
        low_diff: 0,
        invalid: 0,
    };
    private readonly connectionsRejected: Record<ConnectionRejectionReason, number> = {
        ip_limit: 0,
        invalid_messages: 0,
        user_agent: 0,
    };
    private lastZmqMessageAtMs: number | null = null;
    private lastTemplateBuiltAtMs: number | null = null;

    public readonly events$ = new Subject<PoolStreamEvent>();

    public recordShareAccepted(): void {
        this.sharesAcceptedTotal += 1;
    }

    public recordShareRejected(reason: ShareRejectionReason): void {
        this.sharesRejected[reason] += 1;
    }

    public recordConnectionRejected(reason: ConnectionRejectionReason): void {
        this.connectionsRejected[reason] += 1;
    }

    public recordZmqMessage(now = Date.now()): void {
        this.lastZmqMessageAtMs = now;
    }

    public recordTemplateBuilt(now = Date.now()): void {
        this.lastTemplateBuiltAtMs = now;
    }

    public emitEvent(type: PoolStreamEventType, data: Record<string, unknown>): void {
        this.events$.next({
            type,
            timestamp: new Date().toISOString(),
            data,
        });
    }

    public getSnapshot(now = Date.now()): PoolMetricsSnapshot {
        return {
            sharesAcceptedTotal: this.sharesAcceptedTotal,
            sharesRejected: { ...this.sharesRejected },
            connectionsRejected: { ...this.connectionsRejected },
            templateAgeSeconds: this.lastTemplateBuiltAtMs == null
                ? -1
                : Math.max(0, Math.floor((now - this.lastTemplateBuiltAtMs) / 1000)),
            zmqLastMessageSeconds: this.lastZmqMessageAtMs == null
                ? -1
                : Math.max(0, Math.floor((now - this.lastZmqMessageAtMs) / 1000)),
        };
    }

    public resetForTesting(): void {
        this.sharesAcceptedTotal = 0;
        this.sharesRejected.stale = 0;
        this.sharesRejected.duplicate = 0;
        this.sharesRejected.low_diff = 0;
        this.sharesRejected.invalid = 0;
        this.connectionsRejected.ip_limit = 0;
        this.connectionsRejected.invalid_messages = 0;
        this.connectionsRejected.user_agent = 0;
        this.lastZmqMessageAtMs = null;
        this.lastTemplateBuiltAtMs = null;
    }
}

export const poolMetrics = new PoolMetricsRegistry();
