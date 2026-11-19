import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Block } from 'bitcoinjs-lib';

import { DiscordService } from './discord.service';
import { NtfyService } from './ntfy.service';
import { TelegramService } from './telegram.service';


@Injectable()
export class NotificationService implements OnModuleInit {

    private readonly bestDiffAlertMin: number;
    private readonly deviceNotificationsEnabled: boolean;

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramService: TelegramService,
        private readonly discordService: DiscordService,
        private readonly ntfyService: NtfyService
    ) {
        const parsedMin = parseFloat(this.configService.get<string>('BEST_DIFF_ALERT_MIN') ?? '');
        this.bestDiffAlertMin = Number.isFinite(parsedMin) && parsedMin > 0 ? parsedMin : 1_000_000_000;
        this.deviceNotificationsEnabled = (this.configService.get<string>('DEVICE_NOTIFICATIONS_ENABLED') ?? 'true').toLowerCase() !== 'false';
    }

    async onModuleInit(): Promise<void> {
        await this.discordService.notifyRestarted();
    }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        await Promise.allSettled([
            this.discordService.notifySubscribersBlockFound(address, height, block, message),
            this.telegramService.notifySubscribersBlockFound(address, height, block, message),
            this.ntfyService.send('HashSolo: Block Found!', `Height: ${height}, Address: ${address}, Result: ${message}`, 'urgent', 'tada,bitcoin')
        ]);
    }

    public async notifySubscribersBestDifficulty(address: string, worker: string, difficulty: number, userAgent?: string) {
        if (!Number.isFinite(difficulty) || difficulty < this.bestDiffAlertMin) {
            return;
        }
        const device = userAgent ? ` (${userAgent})` : '';
        await Promise.allSettled([
            this.discordService.notifySubscribersBestDifficulty(address, worker, difficulty, userAgent),
            this.telegramService.notifySubscribersBestDifficulty(address, worker, difficulty, userAgent),
            this.ntfyService.send(
                'HashSolo: New Best Difficulty',
                `${worker}${device}: ${difficulty.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
                'default',
                'trophy'
            )
        ]);
    }

    public async notifyWorkerStatus(address: string, worker: string, status: 'online' | 'offline', userAgent?: string) {
        if (!this.deviceNotificationsEnabled) {
            return;
        }
        const device = userAgent ? ` (${userAgent})` : '';
        await Promise.allSettled([
            this.discordService.notifyWorkerStatus(address, worker, status, userAgent),
            this.telegramService.notifyWorkerStatus(address, worker, status, userAgent),
            this.ntfyService.send(
                `HashSolo: Worker ${status}`,
                `${worker}${device} (${address}) is now ${status}.`,
                status === 'offline' ? 'high' : 'low',
                status === 'online' ? 'white_check_mark' : 'warning'
            )
        ]);
    }
}