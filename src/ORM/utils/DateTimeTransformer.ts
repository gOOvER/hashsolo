import { ValueTransformer } from 'typeorm';

export class DateTimeTransformer implements ValueTransformer {
    to(value: Date | string | null | undefined): string | null | undefined {
        if (value == null) {
            return value as null | undefined;
        }
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) {
            return null;
        }
        // Store SQLite-compatible UTC format ('YYYY-MM-DD HH:MM:SS') so DATETIME(...) comparisons work reliably.
        return date.toISOString().slice(0, 19).replace('T', ' ');
    }

    from(value: Date | string | null | undefined): Date | null | undefined {
        if (value == null) {
            return value as null | undefined;
        }
        if (value instanceof Date) {
            return value;
        }
        const normalized = typeof value === 'string' && !value.includes('T')
            ? `${value.replace(' ', 'T')}Z`
            : value;
        const parsed = new Date(normalized);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
}