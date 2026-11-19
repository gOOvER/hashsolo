import { formatHashrate, renderHashrateChartPng } from './discord-chart.util';

describe('discord-chart.util', () => {
    it('formats hashrates across H/s, KH/s, MH/s, GH/s, TH/s', () => {
        expect(formatHashrate(0)).toBe('0 H/s');
        expect(formatHashrate(950)).toBe('950.0 H/s');
        expect(formatHashrate(1_500)).toBe('1.50 KH/s');
        expect(formatHashrate(2_050_000)).toBe('2.05 MH/s');
    });

    it('returns null when fewer than 2 points are provided', () => {
        expect(renderHashrateChartPng([], 'Empty')).toBeNull();
        expect(renderHashrateChartPng([{ label: '2026-11-19T20:00:00Z', data: 1000 }], 'One')).toBeNull();
    });

    it('renders a valid PNG buffer for >= 2 chart points', () => {
        const png = renderHashrateChartPng(
            [
                { label: '2026-11-19T20:00:00Z', data: 1_000_000 },
                { label: '2026-11-19T20:10:00Z', data: 1_850_000 },
                { label: '2026-11-19T20:20:00Z', data: 2_050_000 },
            ],
            'HashSolo Pool Hashrate',
            '2 active miner(s)'
        );

        expect(png).not.toBeNull();
        // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
        expect(png!.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });
});
