import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class NtfyService {

    private readonly baseUrl: string;
    private readonly topic: string;
    private readonly token: string;

    constructor(private readonly configService: ConfigService) {
        this.baseUrl = (this.configService.get<string>('NTFY_URL') ?? '').trim().replace(/\/+$/, '');
        this.topic = (this.configService.get<string>('NTFY_TOPIC') ?? '').trim().replace(/^\/+/, '');
        this.token = (this.configService.get<string>('NTFY_TOKEN') ?? '').trim();
    }

    public isEnabled(): boolean {
        return this.baseUrl.length > 0 && this.topic.length > 0;
    }

    public async send(title: string, message: string, priority: 'min' | 'low' | 'default' | 'high' | 'urgent' = 'default', tags = 'pick'): Promise<void> {
        if (!this.isEnabled()) {
            return;
        }

        const headers: Record<string, string> = {
            'Title': title,
            'Priority': priority,
            'Tags': tags
        };
        if (this.token.length > 0) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        try {
            await fetch(`${this.baseUrl}/${this.topic}`, {
                method: 'POST',
                headers,
                body: message,
                signal: AbortSignal.timeout(5000)
            });
        } catch (e: any) {
            console.error('ntfy notification failed', e?.message ?? e);
        }
    }
}
