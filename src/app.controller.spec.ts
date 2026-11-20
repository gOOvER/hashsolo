import { AppController } from './app.controller';

describe('AppController', () => {
    it('returns live accounting metrics and caches for 15s', async () => {
        const cacheManager = {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
        };
        const addressSettingsService = {
            getHighScores: jest.fn().mockResolvedValue([
                { bestDifficulty: 10.49, updatedAt: '2026-11-19 22:17:30' }
            ]),
        };
        const clientStatisticsService = {
            getAccountingSummary: jest.fn().mockResolvedValue({
                totalCreditedDifficulty: 19.55,
                creditedDifficultyLastHour: 1.56,
                creditedDifficultyLast10Minutes: 0.43,
                hashRateLast10Minutes: 1_800_000,
                hashRateLastHour: 1_870_000,
            }),
        };
        const clientService = {
            getUserAgents: jest.fn().mockResolvedValue([
                { userAgent: 'NMMiner', count: '2', totalHashRate: '2009047', bestDifficulty: '1.21' }
            ]),
        };

        const controller = new AppController(
            cacheManager as any,
            {} as any,
            clientService as any,
            clientStatisticsService as any,
            {} as any,
            {} as any,
            addressSettingsService as any,
        );

        const result = await controller.infoAccounting();

        expect(result).toEqual({
            bestSubmissionDifficulty: 10.49,
            bestSubmissionDifficultyAt: '2026-11-19 22:17:30',
            totalCreditedDifficulty: 19.55,
            creditedDifficultyLastHour: 1.56,
            creditedDifficultyLast10Minutes: 0.43,
            hashRateLast10Minutes: 2009047,
            hashRateLastHour: 1870000,
            networkDifficultyPercent: 0,
        });
        expect(cacheManager.set).toHaveBeenCalledWith('SITE_ACCOUNTING', result, 15 * 1000);
    });
});
