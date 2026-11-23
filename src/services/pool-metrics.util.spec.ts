import { firstValueFrom, take } from 'rxjs';
import { poolMetrics } from './pool-metrics.util';

describe('pool-metrics.util', () => {
    beforeEach(() => {
        poolMetrics.resetForTesting();
    });

    it('tracks accepted/rejected shares, rejected connections, and template/ZMQ ages', () => {
        const initial = poolMetrics.getSnapshot(10_000);
        expect(initial.templateAgeSeconds).toBe(-1);
        expect(initial.zmqLastMessageSeconds).toBe(-1);

        poolMetrics.recordShareAccepted();
        poolMetrics.recordShareAccepted();
        poolMetrics.recordShareRejected('stale');
        poolMetrics.recordShareRejected('duplicate');
        poolMetrics.recordShareRejected('low_diff');
        poolMetrics.recordShareRejected('invalid');
        poolMetrics.recordConnectionRejected('ip_limit');
        poolMetrics.recordConnectionRejected('invalid_messages');
        poolMetrics.recordConnectionRejected('user_agent');
        poolMetrics.recordZmqMessage(7_000);
        poolMetrics.recordTemplateBuilt(5_000);

        const snap = poolMetrics.getSnapshot(10_000);
        expect(snap.sharesAcceptedTotal).toBe(2);
        expect(snap.sharesRejected).toEqual({
            stale: 1,
            duplicate: 1,
            low_diff: 1,
            invalid: 1,
        });
        expect(snap.connectionsRejected).toEqual({
            ip_limit: 1,
            invalid_messages: 1,
            user_agent: 1,
        });
        expect(snap.zmqLastMessageSeconds).toBe(3);
        expect(snap.templateAgeSeconds).toBe(5);
    });

    it('emits live stream events on events$', async () => {
        const nextPromise = firstValueFrom(poolMetrics.events$.pipe(take(1)));
        poolMetrics.emitEvent('best_diff', { difficulty: 12345 });
        const event = await nextPromise;
        expect(event.type).toBe('best_diff');
        expect(event.data).toEqual({ difficulty: 12345 });
    });
});
