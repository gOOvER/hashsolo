import { deflateSync } from 'node:zlib';

export interface ChartPoint {
    label: string | Date;
    data: number;
}

export function formatHashrate(hashrate: number): string {
    if (!Number.isFinite(hashrate) || hashrate <= 0) return '0 H/s';
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
    let idx = 0;
    let val = hashrate;
    while (val >= 1000 && idx < units.length - 1) {
        val /= 1000;
        idx++;
    }
    return `${val.toFixed(val >= 100 ? 1 : 2)} ${units[idx]}`;
}

function escapeXml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatTimeLabel(label: string | Date): string {
    const d = label instanceof Date ? label : new Date(label);
    if (Number.isNaN(d.getTime())) return String(label).slice(0, 10);
    return d.toISOString().slice(11, 16) + ' UTC';
}

function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function renderFallbackPng(coords: Array<{ x: number; y: number }>, width: number, height: number, padLeft: number, padRight: number, padTop: number, plotH: number): Buffer {
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const rowOffset = y * stride;
        raw[rowOffset] = 0; // filter none
        for (let x = 0; x < width; x++) {
            const p = rowOffset + 1 + x * 4;
            raw[p] = 15; raw[p + 1] = 23; raw[p + 2] = 42; raw[p + 3] = 255; // #0f172a
        }
    }

    const setPixel = (x: number, y: number, r: number, g: number, b: number) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const p = y * stride + 1 + x * 4;
        raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = 255;
    };

    // Grid lines (#1e293b)
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
        const gy = Math.round(padTop + plotH - frac * plotH);
        for (let x = padLeft; x < width - padRight; x++) {
            setPixel(x, gy, 30, 41, 59);
        }
    }

    // Thick orange line (#f59e0b)
    for (let i = 1; i < coords.length; i++) {
        const x0 = Math.round(coords[i - 1].x);
        const y0 = Math.round(coords[i - 1].y);
        const x1 = Math.round(coords[i].x);
        const y1 = Math.round(coords[i].y);
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
        for (let s = 0; s <= steps; s++) {
            const cx = Math.round(x0 + ((x1 - x0) * s) / steps);
            const cy = Math.round(y0 + ((y1 - y0) * s) / steps);
            for (let dy = -1; dy <= 1; dy++) {
                setPixel(cx, cy + dy, 245, 158, 11);
            }
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    const idat = deflateSync(raw);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        makePngChunk('IHDR', ihdr),
        makePngChunk('IDAT', idat),
        makePngChunk('IEND', Buffer.alloc(0)),
    ]);
}

export function renderHashrateChartPng(
    points: ChartPoint[],
    title: string,
    subtitle?: string
): Buffer | null {
    const clean = (points || [])
        .map((p) => ({ label: p.label, val: Math.max(0, Number(p.data) || 0) }))
        .filter((p) => Number.isFinite(p.val));

    if (clean.length < 2) {
        return null;
    }

    const width = 820;
    const height = 340;
    const padLeft = 88;
    const padRight = 28;
    const padTop = 64;
    const padBottom = 42;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const maxVal = Math.max(...clean.map((p) => p.val), 1);
    const peakVal = Math.max(...clean.map((p) => p.val));
    const avgVal = clean.reduce((acc, p) => acc + p.val, 0) / clean.length;
    const yMax = maxVal * 1.15;

    const coords = clean.map((p, i) => {
        const x = padLeft + (i / (clean.length - 1)) * plotW;
        const y = padTop + plotH - (p.val / yMax) * plotH;
        return { x, y };
    });

    const linePath = coords
        .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
        .join(' ');
    const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(padTop + plotH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padTop + plotH).toFixed(1)} Z`;

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
        const y = padTop + plotH - frac * plotH;
        const label = formatHashrate(frac * yMax);
        return `<line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}" stroke="#1e293b" stroke-width="1"/>
                <text x="${padLeft - 10}" y="${(y + 4).toFixed(1)}" fill="#94a3b8" font-size="12" font-family="DejaVu Sans, Arial, sans-serif" text-anchor="end">${escapeXml(label)}</text>`;
    }).join('\n');

    const firstLabel = formatTimeLabel(clean[0].label);
    const midLabel = formatTimeLabel(clean[Math.floor(clean.length / 2)].label);
    const lastLabel = formatTimeLabel(clean[clean.length - 1].label);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#f59e0b" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="14" fill="#0f172a"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="13" fill="none" stroke="#1e293b" stroke-width="1.5"/>

  <text x="${padLeft}" y="30" fill="#f8fafc" font-size="18" font-weight="bold" font-family="DejaVu Sans, Arial, sans-serif">${escapeXml(title)}</text>
  ${subtitle ? `<text x="${padLeft}" y="48" fill="#94a3b8" font-size="12" font-family="DejaVu Sans, Arial, sans-serif">${escapeXml(subtitle)}</text>` : ''}
  <text x="${width - padRight}" y="30" fill="#fbbf24" font-size="13" font-weight="bold" font-family="DejaVu Sans, Arial, sans-serif" text-anchor="end">Peak: ${escapeXml(formatHashrate(peakVal))}  |  Avg: ${escapeXml(formatHashrate(avgVal))}</text>

  ${yTicks}

  <path d="${areaPath}" fill="url(#areaGrad)"/>
  <path d="${linePath}" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>

  <text x="${padLeft}" y="${height - 14}" fill="#94a3b8" font-size="12" font-family="DejaVu Sans, Arial, sans-serif" text-anchor="start">${escapeXml(firstLabel)}</text>
  <text x="${padLeft + plotW / 2}" y="${height - 14}" fill="#94a3b8" font-size="12" font-family="DejaVu Sans, Arial, sans-serif" text-anchor="middle">${escapeXml(midLabel)}</text>
  <text x="${width - padRight}" y="${height - 14}" fill="#94a3b8" font-size="12" font-family="DejaVu Sans, Arial, sans-serif" text-anchor="end">${escapeXml(lastLabel)}</text>
</svg>`;

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Resvg } = require('@resvg/resvg-js');
        const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
        return Buffer.from(resvg.render().asPng());
    } catch {
        return renderFallbackPng(coords, width, height, padLeft, padRight, padTop, plotH);
    }
}
