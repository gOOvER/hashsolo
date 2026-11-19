import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class DiscordSubscriptionsEntity extends TrackedEntity {

    @PrimaryGeneratedColumn()
    id: number;

    @Index()
    @Column({ length: 62, type: 'varchar' })
    address: string;

    @Index()
    @Column({ length: 32, type: 'varchar' })
    discordUserId: string;

    @Column({ length: 32, type: 'varchar' })
    discordChannelId: string;
}
