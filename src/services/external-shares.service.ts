import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalPoolShare } from '../models/ExternalPoolShare';

@Injectable()
export class ExternalSharesService {
  private readonly shareApiUrl: string;
  private readonly shareApiKey: string;

  constructor(
    private readonly configService: ConfigService
  ) {
    this.shareApiUrl = this.configService.get('SHARE_SUBMISSION_URL') || '';
    this.shareApiKey = this.configService.get('SHARE_SUBMISSION_API_KEY') || '';
  }

  public submitShare(share: ExternalPoolShare): void {
    if (!this.shareApiUrl) {
      return;
    }
    void fetch(`${this.shareApiUrl}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.shareApiKey
      },
      body: JSON.stringify(share),
      signal: AbortSignal.timeout(5000)
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        console.log('External share accepted');
      })
      .catch((error: any) => console.error('Failed to submit share to API:', error?.message ?? error));
  }
}
