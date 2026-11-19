import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DiscordSubscriptionsEntity } from './discord-subscriptions.entity';
import { DiscordSubscriptionsService } from './discord-subscriptions.service';

@Module({
    imports: [TypeOrmModule.forFeature([DiscordSubscriptionsEntity])],
    providers: [DiscordSubscriptionsService],
    exports: [DiscordSubscriptionsService],
})
export class DiscordSubscriptionsModule { }
