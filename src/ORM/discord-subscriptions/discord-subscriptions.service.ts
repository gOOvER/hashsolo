import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DiscordSubscriptionsEntity } from './discord-subscriptions.entity';

@Injectable()
export class DiscordSubscriptionsService {
    constructor(
        @InjectRepository(DiscordSubscriptionsEntity)
        private readonly discordSubscriptions: Repository<DiscordSubscriptionsEntity>
    ) { }

    public async getSubscriptions(address: string) {
        return await this.discordSubscriptions.find({ where: { address } });
    }

    public async getSubscriptionsByUser(discordUserId: string) {
        return await this.discordSubscriptions.find({ where: { discordUserId } });
    }

    public async saveSubscription(discordUserId: string, discordChannelId: string, address: string) {
        const existing = await this.discordSubscriptions.findOne({ where: { discordUserId, address } });
        if (existing) {
            existing.discordChannelId = discordChannelId;
            return await this.discordSubscriptions.save(existing);
        }
        return await this.discordSubscriptions.save({
            discordUserId,
            discordChannelId,
            address
        });
    }

    public async removeSubscription(discordUserId: string, address?: string) {
        if (address) {
            return await this.discordSubscriptions.softDelete({ discordUserId, address });
        }
        return await this.discordSubscriptions.softDelete({ discordUserId });
    }
}
