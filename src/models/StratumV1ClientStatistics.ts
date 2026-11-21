import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';

const CACHE_SIZE = 30;

function parseEnvPositiveNumber(raw: string | undefined, fallback: number): number {
    const parsed = parseFloat(raw ?? '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TARGET_SUBMISSION_PER_SECOND = parseEnvPositiveNumber(process.env.VARDIFF_TARGET_TIME, 10);
const MIN_DIFF = parseEnvPositiveNumber(process.env.VARDIFF_MIN_DIFF, 0.00001);
export class StratumV1ClientStatistics {

    private shares = 0;
    private acceptedCount = 0;

    private submissionCacheStart: Date;
    private submissionCache: { time: Date, difficulty: number }[] = [];

    private currentTimeSlot: number = null;
    private lastSave: number = null;
	
	public hashRate = 0;

    private previousTimeSlotTime: Date;
    private currentTimeSlotTime: Date;

    private previousShares = 0;

    constructor(
        private readonly clientStatisticsService: ClientStatisticsService
    ) {
        this.submissionCacheStart = new Date();
    }


    // We don't want to save them here because it can be DB intensive, instead do it every once in
    // awhile with saveShares()
    public async addShares(client: ClientEntity, targetDifficulty: number) {

        // 10 min
        const coeff = 1000 * 60 * 10;
        const date = new Date();
        const timeSlot = new Date(Math.floor(date.getTime() / coeff) * coeff).getTime();

        if (this.submissionCache.length > CACHE_SIZE) {
            this.submissionCache.shift();
        }
        this.submissionCache.push({
            time: date,
            difficulty: targetDifficulty,
        });


        if (this.currentTimeSlot == null) {
            // First record, insert it
            this.previousTimeSlotTime = new Date();
            this.currentTimeSlotTime = new Date();
            this.currentTimeSlot = timeSlot;
            this.lastSave = date.getTime();
            this.shares += targetDifficulty;
            this.acceptedCount++;
            await this.clientStatisticsService.insert({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
        } else if (this.currentTimeSlot != timeSlot) {
            // Transitioning to a new time slot,
            // First update the old time slot with the latest data
            this.lastSave = date.getTime();
            await this.clientStatisticsService.update({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
            this.previousShares = this.shares;
            this.previousTimeSlotTime = this.currentTimeSlotTime;
            this.currentTimeSlotTime = new Date();
            // Set the new time slot and add incoming shares then insert it
            this.currentTimeSlot = timeSlot;
            this.shares = targetDifficulty;
            this.acceptedCount = 1;
            await this.clientStatisticsService.insert({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
        } else if ((date.getTime() - 60 * 1000) > this.lastSave) {
            // If we haven't saved for a minute, update the table
            this.lastSave = date.getTime();
            this.shares += targetDifficulty;
            this.acceptedCount++;
            await this.clientStatisticsService.update({
                time: this.currentTimeSlot,
                shares: this.shares,
                acceptedCount: this.acceptedCount,
                address: client.address,
                clientName: client.clientName,
                sessionId: client.sessionId
            });
        } else {
            // Accept the shares if none of the prior conditions are met,
            // saving to memory for storing later
            this.shares += targetDifficulty;
            this.acceptedCount++;
			if (this.shares > 0) {
                const time = new Date().getTime() - this.previousTimeSlotTime.getTime();
                if (time > 0) {
                    // Use at least a 60s warmup denominator in the first slot so early lucky shares don't spike hashrate.
                    const elapsedSeconds = this.previousShares === 0
                        ? Math.max(time / 1000, 60)
                        : time / 1000;
                    this.hashRate = ((this.previousShares + this.shares) * 4294967296) / elapsedSeconds;
                }
            }
        }

    }

    public getSuggestedDifficulty(clientDifficulty: number) {

        // miner hasn't submitted shares in one minute
        if (this.submissionCache.length < 5) {
            const lastTime = this.submissionCache.length > 0
                ? this.submissionCache[this.submissionCache.length - 1].time.getTime()
                : this.submissionCacheStart.getTime();
            if ((Date.now() - lastTime) / 1000 > 60) {
                this.submissionCacheStart = new Date();
                return this.nearestPowerOfTwo(clientDifficulty / 6);
            } else {
                return null;
            }
        }

        const lastSubmissionTime = this.submissionCache[this.submissionCache.length - 1].time.getTime();
        if ((Date.now() - lastSubmissionTime) / 1000 > 60) {
            this.submissionCache = [];
            this.submissionCacheStart = new Date();
            return this.nearestPowerOfTwo(clientDifficulty / 6);
        }

        // Exclude the first entry whose timestamp marks the start of the (N-1) intervals (#167).
        const sum = this.submissionCache.slice(1).reduce((pre, cur) => {
            pre += cur.difficulty;
            return pre;
        }, 0);
        const diffSeconds = (this.submissionCache[this.submissionCache.length - 1].time.getTime() - this.submissionCache[0].time.getTime()) / 1000;
        if (diffSeconds <= 0) {
            return null;
        }

        const difficultyPerSecond = sum / diffSeconds;

        const targetDifficulty = difficultyPerSecond * TARGET_SUBMISSION_PER_SECOND;

        if ((clientDifficulty * 2) < targetDifficulty || (clientDifficulty / 2) > targetDifficulty) {
            return this.nearestPowerOfTwo(targetDifficulty)
        }

        return null;
    }

    private nearestPowerOfTwo(val: number): number | null {
        if (!Number.isFinite(val) || val <= 0) {
            return null;
        }
        if (val < MIN_DIFF) {
            return MIN_DIFF;
        }
        const res = Math.pow(2, Math.floor(Math.log2(val)));
        return res < MIN_DIFF ? MIN_DIFF : res;
    }

}