import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { ClientService } from '../ORM/client/client.service';
import { TelegramSubscriptionsService } from '../ORM/telegram-subscriptions/telegram-subscriptions.service';


@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {

    private bot: AxiosInstance;
    private updateOffset = 0;
    private pollingTimer: NodeJS.Timeout;
    private isPolling = false;

    constructor(
        private readonly configService: ConfigService,
        private readonly telegramSubscriptionsService: TelegramSubscriptionsService,
        private readonly clientService: ClientService,
        private readonly addressSettingsService: AddressSettingsService
    ) {
        const token: string | null = this.configService.get('TELEGRAM_BOT_TOKEN');
        if (token == null || token.length < 1) {
            return;
        }
        this.bot = axios.create({
            baseURL: `https://api.telegram.org/bot${token}/`,
            timeout: 10000
        });
        console.log('Telegram bot init');


    }

    async onModuleInit(): Promise<void> {

        if (this.bot == null) {
            return;
        }

        await this.pollUpdates();
        this.pollingTimer = setInterval(async () => {
            if (this.isPolling) {
                return;
            }
            this.isPolling = true;
            try {
                await this.pollUpdates();
            } finally {
                this.isPolling = false;
            }
        }, 2000);
    }

    onModuleDestroy(): void {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = undefined;
        }
    }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        if (this.bot == null) {
            return;
        }

        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        await Promise.all(subscribers.map(subscriber => {
            return this.sendMessage(subscriber.telegramChatId, `Block Found! Result: ${message}, Height: ${height}`);
        }));
    }

    public async notifySubscribersBestDifficulty(address: string, worker: string, difficulty: number, userAgent?: string) {
        if (this.bot == null) {
            return;
        }

        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        const device = userAgent ? ` (${userAgent})` : '';
        await Promise.all(subscribers.map(subscriber => {
            return this.sendMessage(
                subscriber.telegramChatId,
                `New Best Difficulty for ${worker}${device}: ${difficulty.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
            );
        }));
    }

    public async notifyWorkerStatus(address: string, worker: string, status: 'online' | 'offline', userAgent?: string) {
        if (this.bot == null) {
            return;
        }

        const subscribers = await this.telegramSubscriptionsService.getSubscriptions(address);
        const device = userAgent ? ` (${userAgent})` : '';
        const icon = status === 'online' ? '🟢' : '🔴';
        await Promise.all(subscribers.map(subscriber => {
            return this.sendMessage(
                subscriber.telegramChatId,
                `${icon} Worker ${worker}${device} is now ${status}.`
            );
        }));
    }

    private async pollUpdates() {
        try {
            const response = await this.bot.get('getUpdates', {
                params: {
                    offset: this.updateOffset,
                    timeout: 0
                }
            });

            for (const update of response.data.result ?? []) {
                this.updateOffset = update.update_id + 1;
                await this.handleMessage(update.message);
            }
        } catch (e: any) {
            console.error('Telegram polling failed', e?.message ?? e);
        }
    }

    private async handleMessage(msg: any) {
        if (msg?.text == null) {
            return;
        }

        if (msg.text.startsWith('/subscribe')) {
            const address = msg.text.split('/subscribe ')[1]?.trim();
            const network = this.configService.get('NETWORK');
            if (!address || validate(address, network) == false) {
                await this.sendMessage(msg.chat.id, 'Invalid address.');
                return;
            }
            await this.telegramSubscriptionsService.saveSubscription(msg.chat.id, address);
            await this.sendMessage(msg.chat.id, 'Subscribed!');
            return;
        }

        if (msg.text.startsWith('/stats')) {
            await this.handleStatsCommand(msg);
            return;
        }

        if (msg.text.startsWith('/workers')) {
            await this.handleWorkersCommand(msg);
            return;
        }

        if (msg.text.startsWith('/start')) {
            await this.sendMessage(
                msg.chat.id,
                'Welcome to the HashSolo bot.\nCommands:\n/subscribe <address>\n/stats [address]\n/workers [address]'
            );
            return;
        }

        console.log(msg);
    }

    private async resolveTargetAddresses(chatId: number, rawArg?: string): Promise<string[]> {
        const arg = rawArg?.trim();
        if (arg) {
            return [arg];
        }
        const subs = await this.telegramSubscriptionsService.getSubscriptionsByChatId(chatId);
        return [...new Set(subs.map(s => s.address))];
    }

    private formatHashrate(hs: number): string {
        if (!Number.isFinite(hs) || hs <= 0) return '0 H/s';
        const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
        const idx = Math.min(units.length - 1, Math.floor(Math.log10(hs) / 3));
        return `${(hs / Math.pow(1000, idx)).toFixed(2)} ${units[idx]}`;
    }

    private async handleStatsCommand(msg: any) {
        const arg = msg.text.split(/\s+/)[1];
        const addresses = await this.resolveTargetAddresses(msg.chat.id, arg);
        if (addresses.length === 0) {
            await this.sendMessage(msg.chat.id, 'No subscribed address found. Use /subscribe <address> or /stats <address>.');
            return;
        }

        const lines: string[] = [];
        for (const addr of addresses) {
            const [clients, settings] = await Promise.all([
                this.clientService.getByAddress(addr),
                this.addressSettingsService.getSettings(addr, false)
            ]);
            const totalHash = clients.reduce((acc, c) => acc + (Number(c.hashRate) || 0), 0);
            const bestDiff = settings?.bestDifficulty ?? clients.reduce((max, c) => Math.max(max, Number(c.bestDifficulty) || 0), 0);
            lines.push(`📊 ${addr}\nWorkers: ${clients.length} | Hashrate: ${this.formatHashrate(totalHash)} | Best Diff: ${bestDiff.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
        }
        await this.sendMessage(msg.chat.id, lines.join('\n\n'));
    }

    private async handleWorkersCommand(msg: any) {
        const arg = msg.text.split(/\s+/)[1];
        const addresses = await this.resolveTargetAddresses(msg.chat.id, arg);
        if (addresses.length === 0) {
            await this.sendMessage(msg.chat.id, 'No subscribed address found. Use /subscribe <address> or /workers <address>.');
            return;
        }

        const sections: string[] = [];
        for (const addr of addresses) {
            const clients = await this.clientService.getByAddress(addr);
            if (clients.length === 0) {
                sections.push(`⛏️ ${addr}: no active workers`);
                continue;
            }
            const workerLines = clients.map(c =>
                `• ${c.clientName || 'default'} (${c.userAgent || 'unknown'}): ${this.formatHashrate(Number(c.hashRate) || 0)} | Best: ${(Number(c.bestDifficulty) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
            );
            sections.push(`⛏️ ${addr}\n${workerLines.join('\n')}`);
        }
        await this.sendMessage(msg.chat.id, sections.join('\n\n'));
    }

    private async sendMessage(chatId: number | string, text: string) {
        try {
            await this.bot.post('sendMessage', {
                chat_id: chatId,
                text
            });
        } catch (e: any) {
            console.error(`Telegram sendMessage failed (${chatId}):`, e?.message ?? e);
        }
    }
}
