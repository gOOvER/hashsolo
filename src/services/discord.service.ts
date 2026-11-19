import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validate } from 'bitcoin-address-validation';
import { Block } from 'bitcoinjs-lib';
import {
    ActionRowBuilder,
    ActivityType,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChatInputCommandInteraction,
    Client,
    Collection,
    Events,
    GatewayIntentBits,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags,
    REST,
    Routes,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SlashCommandBuilder,
    TextChannel,
    TextDisplayBuilder,
    ContainerBuilder,
} from 'discord.js';

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { DiscordSubscriptionsService } from '../ORM/discord-subscriptions/discord-subscriptions.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { formatHashrate, renderHashrateChartPng } from './discord-chart.util';

interface V2Payload {
    components: any[];
    files?: AttachmentBuilder[];
    flags: number;
}

interface IDiscordCommand {
    data: ReturnType<SlashCommandBuilder['toJSON']>;
    execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

const POOL_URL = 'https://hashsolo.goover.dev';

@Injectable()
export class DiscordService implements OnModuleInit, OnModuleDestroy {

    private readonly token: string;
    private readonly clientId: string;
    private readonly guildId: string;
    private readonly channelId: string;

    private bot: Client | null = null;
    private commandCollection: Collection<string, IDiscordCommand> = new Collection();
    private presenceTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly configService: ConfigService,
        private readonly clientService: ClientService,
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly addressSettingsService: AddressSettingsService,
        private readonly blocksService: BlocksService,
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly discordSubscriptionsService: DiscordSubscriptionsService,
    ) {
        if (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE == '0') {
            this.token = this.configService.get('DISCORD_BOT_TOKEN') ?? '';
            this.clientId = this.configService.get('DISCORD_BOT_CLIENTID') ?? '';
            this.guildId = this.configService.get('DISCORD_BOT_GUILD_ID') ?? '';
            this.channelId = this.configService.get('DISCORD_BOT_CHANNEL_ID') ?? '';

            if (!this.token || !this.clientId || !this.guildId || !this.channelId) {
                return;
            }

            console.log('discord init');
            this.registerCommandHandlers();
            this.bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
            void this.bot.login(this.token);
        }
    }

    async onModuleInit(): Promise<void> {
        if (this.bot == null) {
            return;
        }

        await this.registerCommands();

        this.bot.once(Events.ClientReady, () => {
            void this.updatePresence();
            this.presenceTimer = setInterval(() => {
                void this.updatePresence();
            }, 60 * 1000);
        });

        this.bot.on(Events.InteractionCreate, async (interaction) => {
            try {
                if (interaction.isChatInputCommand()) {
                    const command = this.commandCollection.get(interaction.commandName);
                    if (!command) {
                        return;
                    }
                    await command.execute(interaction);
                } else if (interaction.isButton()) {
                    await this.handleButtonInteraction(interaction);
                }
            } catch (error) {
                console.error('Discord interaction error:', error);
                const errPayload = this.buildSimpleContainer(0xef4444, 'Error', 'Something went wrong while running this action.');
                if (interaction.isRepliable()) {
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({ ...errPayload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
                    } else {
                        await interaction.reply({ ...errPayload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
                    }
                }
            }
        });
    }

    onModuleDestroy(): void {
        if (this.presenceTimer) {
            clearInterval(this.presenceTimer);
            this.presenceTimer = null;
        }
        if (this.bot) {
            this.bot.destroy();
            this.bot = null;
        }
    }

    private registerCommandHandlers() {
        const poolCmd: IDiscordCommand = {
            data: new SlashCommandBuilder()
                .setName('pool')
                .setDescription('Live pool overview, hashrate, miners & chart')
                .toJSON(),
            execute: async (interaction) => {
                await interaction.deferReply();
                const payload = await this.buildPoolPayload();
                await interaction.editReply(payload);
            }
        };

        const nodeCmd: IDiscordCommand = {
            data: new SlashCommandBuilder()
                .setName('node')
                .setDescription('Live Bitcoin Core node sync status & next block reward')
                .toJSON(),
            execute: async (interaction) => {
                await interaction.deferReply();
                const payload = await this.buildNodePayload();
                await interaction.editReply(payload);
            }
        };

        const statsCmd: IDiscordCommand = {
            data: new SlashCommandBuilder()
                .setName('stats')
                .setDescription('Mining stats & chart for a BTC address (or your subscribed address)')
                .addStringOption((opt) =>
                    opt.setName('address').setDescription('Bitcoin address').setRequired(false)
                )
                .toJSON(),
            execute: async (interaction) => {
                await interaction.deferReply();
                const address = await this.resolveAddress(interaction.user.id, interaction.options.getString('address'));
                if (!address) {
                    await interaction.editReply(this.buildMissingAddressPayload());
                    return;
                }
                const payload = await this.buildStatsPayload(address);
                await interaction.editReply(payload);
            }
        };

        const workersCmd: IDiscordCommand = {
            data: new SlashCommandBuilder()
                .setName('workers')
                .setDescription('List all active workers for a BTC address')
                .addStringOption((opt) =>
                    opt.setName('address').setDescription('Bitcoin address').setRequired(false)
                )
                .toJSON(),
            execute: async (interaction) => {
                await interaction.deferReply();
                const address = await this.resolveAddress(interaction.user.id, interaction.options.getString('address'));
                if (!address) {
                    await interaction.editReply(this.buildMissingAddressPayload());
                    return;
                }
                const payload = await this.buildWorkersPayload(address);
                await interaction.editReply(payload);
            }
        };

        const chartCmd: IDiscordCommand = {
            data: new SlashCommandBuilder()
                .setName('chart')
                .setDescription('Render a live hashrate chart (pool-wide or for a BTC address)')
                .addStringOption((opt) =>
                    opt.setName('address').setDescription('Optional Bitcoin address').setRequired(false)
                )
                .toJSON(),
            execute: async (interaction) => {
                await interaction.deferReply();
                const explicit = interaction.options.getString('address')?.trim();
                const payload = await this.buildChartPayload(explicit || null);
                await interaction.editReply(payload);
            }
        };

        const subscribeCmd: IDiscordCommand = {
            data: new SlashCommandBuilder()
                .setName('subscribe')
                .setDescription('Subscribe to block, best-difficulty & worker alerts for a BTC address')
                .addStringOption((opt) =>
                    opt.setName('address').setDescription('Bitcoin address').setRequired(true)
                )
                .toJSON(),
            execute: async (interaction) => {
                const address = interaction.options.getString('address', true).trim();
                if (!validate(address)) {
                    await interaction.reply({
                        ...this.buildSimpleContainer(0xef4444, 'Invalid Bitcoin Address', `\`${address}\` is not a valid Bitcoin address.`),
                        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    });
                    return;
                }
                await this.discordSubscriptionsService.saveSubscription(interaction.user.id, interaction.channelId, address);
                await interaction.reply({
                    ...this.buildSimpleContainer(
                        0x22c55e,
                        'Subscribed to HashSolo Alerts',
                        `You will be pinged for **${this.maskAddress(address)}** on:\n• Block found\n• New best difficulty\n• Worker online/offline\n\nYou can now also run \`/stats\` and \`/workers\` without typing your address.`
                    ),
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                });
            }
        };

        const unsubscribeCmd: IDiscordCommand = {
            data: new SlashCommandBuilder()
                .setName('unsubscribe')
                .setDescription('Unsubscribe from HashSolo alerts')
                .addStringOption((opt) =>
                    opt.setName('address').setDescription('Specific address (omit to remove all)').setRequired(false)
                )
                .toJSON(),
            execute: async (interaction) => {
                const address = interaction.options.getString('address')?.trim();
                await this.discordSubscriptionsService.removeSubscription(interaction.user.id, address);
                await interaction.reply({
                    ...this.buildSimpleContainer(
                        0x64748b,
                        'Unsubscribed',
                        address
                            ? `Removed alert subscription for **${this.maskAddress(address)}**.`
                            : 'Removed all your HashSolo alert subscriptions.'
                    ),
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                });
            }
        };

        [poolCmd, nodeCmd, statsCmd, workersCmd, chartCmd, subscribeCmd, unsubscribeCmd].forEach((cmd) => {
            this.commandCollection.set(cmd.data.name, cmd);
        });
    }

    private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
        const [, action, target, arg] = interaction.customId.split(':');
        if (action !== 'refresh') return;

        await interaction.deferUpdate();
        if (target === 'pool') {
            await interaction.editReply(await this.buildPoolPayload());
        } else if (target === 'node') {
            await interaction.editReply(await this.buildNodePayload());
        } else if (target === 'stats' && arg) {
            await interaction.editReply(await this.buildStatsPayload(arg));
        } else if (target === 'workers' && arg) {
            await interaction.editReply(await this.buildWorkersPayload(arg));
        } else if (target === 'chart') {
            await interaction.editReply(await this.buildChartPayload(arg || null));
        }
    }

    private async registerCommands() {
        const rest = new REST().setToken(this.token);
        const body = Array.from(this.commandCollection.values()).map((c) => c.data);
        try {
            console.log(`Started refreshing ${body.length} Discord application (/) commands.`);
            const data = await rest.put(
                Routes.applicationGuildCommands(this.clientId, this.guildId),
                { body },
            ) as any[];
            console.log(`Successfully reloaded ${data.length} Discord application (/) commands.`);
        } catch (error) {
            console.error('Failed to register Discord commands:', error);
        }
    }

    private async updatePresence(): Promise<void> {
        if (!this.bot?.user) return;
        try {
            const userAgents = await this.clientService.getUserAgents();
            const totalMiners = userAgents.reduce((acc, ua) => acc + (parseInt(ua.count, 10) || 0), 0);
            const totalHashRate = userAgents.reduce((acc, ua) => acc + (parseFloat(ua.totalHashRate) || 0), 0);
            this.bot.user.setPresence({
                status: 'online',
                activities: [{
                    name: `${totalMiners} Miner${totalMiners === 1 ? '' : 's'} · ${formatHashrate(totalHashRate)}`,
                    type: ActivityType.Watching,
                }],
            });
        } catch {
            // Keep existing presence on transient DB errors
        }
    }

    private async resolveAddress(discordUserId: string, explicit: string | null): Promise<string | null> {
        if (explicit && explicit.trim().length > 0) {
            return explicit.trim();
        }
        const subs = await this.discordSubscriptionsService.getSubscriptionsByUser(discordUserId);
        return subs.length > 0 ? subs[0].address : null;
    }

    private maskAddress(address: string): string {
        return address.length > 14 ? `${address.slice(0, 8)}...${address.slice(-6)}` : address;
    }

    private formatDiff(diff: number): string {
        if (!Number.isFinite(diff) || diff <= 0) return '0';
        if (diff >= 1e12) return `${(diff / 1e12).toFixed(2)} T`;
        if (diff >= 1e9) return `${(diff / 1e9).toFixed(2)} G`;
        if (diff >= 1e6) return `${(diff / 1e6).toFixed(2)} M`;
        if (diff >= 1e3) return `${(diff / 1e3).toFixed(2)} K`;
        return diff.toFixed(diff >= 10 ? 1 : 2);
    }

    private buildMissingAddressPayload(): V2Payload {
        return this.buildSimpleContainer(
            0xf59e0b,
            'No Address Provided',
            'Pass a Bitcoin address (`address:...`) or subscribe first with `/subscribe <address>`.'
        );
    }

    private buildSimpleContainer(accentColor: number, title: string, body: string): V2Payload {
        const container = new ContainerBuilder()
            .setAccentColor(accentColor)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## ${title}`),
                new TextDisplayBuilder().setContent(body)
            );
        return {
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        };
    }

    private async buildPoolPayload(): Promise<V2Payload> {
        const [userAgents, highScores, blocksFound, chartPoints] = await Promise.all([
            this.clientService.getUserAgents(),
            this.addressSettingsService.getHighScores(),
            this.blocksService.getFoundBlocks(),
            this.clientStatisticsService.getChartDataForSite(),
        ]);

        const totalMiners = userAgents.reduce((acc, ua) => acc + (parseInt(ua.count, 10) || 0), 0);
        const totalHashRate = userAgents.reduce((acc, ua) => acc + (parseFloat(ua.totalHashRate) || 0), 0);
        const topDiff = highScores?.[0]?.bestDifficulty ?? 0;

        const deviceLines = userAgents.length > 0
            ? userAgents.map((ua) => `• **${ua.userAgent || 'unknown'}**: ${ua.count} active · \`${formatHashrate(parseFloat(ua.totalHashRate) || 0)}\` · Best \`${this.formatDiff(parseFloat(ua.bestDifficulty) || 0)}\``).join('\n')
            : '_No active miners right now._';

        const container = new ContainerBuilder()
            .setAccentColor(0xf59e0b)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## ⛏️ HashSolo Pool Overview'),
                new TextDisplayBuilder().setContent(
                    `**Total Hashrate:** \`${formatHashrate(totalHashRate)}\`   |   **Active Miners:** \`${totalMiners}\`\n**Top Best Diff:** \`${this.formatDiff(topDiff)}\`   |   **Blocks Found:** \`${blocksFound.length}\``
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Connected Devices**\n${deviceLines}`));

        const files: AttachmentBuilder[] = [];
        const chartPng = renderHashrateChartPng(chartPoints, 'HashSolo Pool Hashrate', `${totalMiners} active miner(s)`);
        if (chartPng) {
            files.push(new AttachmentBuilder(chartPng, { name: 'pool-hashrate.png' }));
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL('attachment://pool-hashrate.png')
                )
            );
        }

        container.addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('hashsolo:refresh:pool').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setLabel('Open Dashboard').setURL(POOL_URL).setStyle(ButtonStyle.Link)
            )
        );

        return {
            components: [container],
            files,
            flags: MessageFlags.IsComponentsV2,
        };
    }

    private async buildNodePayload(): Promise<V2Payload> {
        const [chainInfo, netInfo, rewardInfo] = await Promise.all([
            this.bitcoinRpcService.getBlockchainInfo(),
            this.bitcoinRpcService.getNetworkInfo(),
            this.bitcoinRpcService.getNextBlockReward(),
        ]);

        const reachable = chainInfo != null;
        const ready = reachable && !chainInfo.initialblockdownload;
        const statusLabel = !reachable ? '🔴 Offline' : ready ? '🟢 Synced' : '🟡 Syncing (IBD)';
        const accent = !reachable ? 0xef4444 : ready ? 0x22c55e : 0xf59e0b;

        const details = reachable
            ? [
                `**Status:** ${statusLabel} (\`${chainInfo.chain}\`)`,
                `**Blocks / Headers:** \`${chainInfo.blocks.toLocaleString('en-US')}\` / \`${chainInfo.headers.toLocaleString('en-US')}\` (${(chainInfo.verificationprogress * 100).toFixed(2)}%)`,
                `**P2P Peers:** \`${netInfo?.connections ?? 0}\`   |   **Pruned:** \`${chainInfo.pruned ? 'Yes' : 'No'}\` (\`${(chainInfo.size_on_disk / 1e9).toFixed(2)} GB\`)`,
                rewardInfo ? `**Next Block Reward:** \`${(rewardInfo.rewardSats / 1e8).toFixed(4)} BTC\` (Height \`${rewardInfo.height.toLocaleString('en-US')}\`)` : ''
            ].filter(Boolean).join('\n')
            : 'Bitcoin Core RPC is currently unreachable.';

        const container = new ContainerBuilder()
            .setAccentColor(accent)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## ₿ Bitcoin Core Node'),
                new TextDisplayBuilder().setContent(details)
            )
            .addActionRowComponents(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('hashsolo:refresh:node').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setLabel('Open Dashboard').setURL(POOL_URL).setStyle(ButtonStyle.Link)
                )
            );

        return {
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        };
    }

    private async buildStatsPayload(address: string): Promise<V2Payload> {
        const [workers, settings, chartPoints] = await Promise.all([
            this.clientService.getByAddress(address),
            this.addressSettingsService.getSettings(address, false),
            this.clientStatisticsService.getChartDataForAddress(address),
        ]);

        const totalHashrate = workers.reduce((acc, w) => acc + (Number(w.hashRate) || 0), 0);
        const bestDiff = Number(settings?.bestDifficulty ?? 0);

        const workerSummary = workers.length > 0
            ? workers.slice(0, 8).map((w) => `• \`${w.clientName}\` (${w.userAgent || 'unknown'} · \`${w.sessionId}\`): \`${formatHashrate(Number(w.hashRate) || 0)}\` | Best \`${this.formatDiff(Number(w.bestDifficulty) || 0)}\``).join('\n')
            : '_No active workers right now._';

        const container = new ContainerBuilder()
            .setAccentColor(0x3b82f6)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## 📊 Miner Stats · \`${this.maskAddress(address)}\``),
                new TextDisplayBuilder().setContent(
                    `**Active Workers:** \`${workers.length}\`   |   **Total Hashrate:** \`${formatHashrate(totalHashrate)}\`   |   **Best Difficulty:** \`${this.formatDiff(bestDiff)}\``
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(workerSummary));

        const files: AttachmentBuilder[] = [];
        const chartPng = renderHashrateChartPng(chartPoints, `Hashrate · ${this.maskAddress(address)}`, `${workers.length} active worker(s)`);
        if (chartPng) {
            files.push(new AttachmentBuilder(chartPng, { name: 'address-hashrate.png' }));
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL('attachment://address-hashrate.png')
                )
            );
        }

        container.addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`hashsolo:refresh:stats:${address}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setLabel('Open Address Dashboard').setURL(`${POOL_URL}/#/app/${address}`).setStyle(ButtonStyle.Link)
            )
        );

        return {
            components: [container],
            files,
            flags: MessageFlags.IsComponentsV2,
        };
    }

    private async buildWorkersPayload(address: string): Promise<V2Payload> {
        const workers = await this.clientService.getByAddress(address);
        const lines = workers.length > 0
            ? workers.map((w, idx) => {
                const lastSeen = w.updatedAt ? `<t:${Math.floor(new Date(w.updatedAt).getTime() / 1000)}:R>` : 'unknown';
                return `**${idx + 1}. \`${w.clientName}\`** (${w.userAgent || 'unknown'})\nSession: \`${w.sessionId}\` · Hashrate: \`${formatHashrate(Number(w.hashRate) || 0)}\` · Best: \`${this.formatDiff(Number(w.bestDifficulty) || 0)}\` · Last seen: ${lastSeen}`;
            }).join('\n\n')
            : '_No active workers connected for this address._';

        const container = new ContainerBuilder()
            .setAccentColor(workers.length > 0 ? 0x22c55e : 0x64748b)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`## 🖥️ Active Workers (${workers.length}) · \`${this.maskAddress(address)}\``),
                new TextDisplayBuilder().setContent(lines)
            )
            .addActionRowComponents(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`hashsolo:refresh:workers:${address}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setLabel('Open Address Dashboard').setURL(`${POOL_URL}/#/app/${address}`).setStyle(ButtonStyle.Link)
                )
            );

        return {
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        };
    }

    private async buildChartPayload(address: string | null): Promise<V2Payload> {
        const points = address
            ? await this.clientStatisticsService.getChartDataForAddress(address)
            : await this.clientStatisticsService.getChartDataForSite();

        const title = address ? `Hashrate Chart · ${this.maskAddress(address)}` : 'HashSolo Pool Hashrate Chart';
        const png = renderHashrateChartPng(points, title);

        if (!png) {
            return this.buildSimpleContainer(0x64748b, title, 'Not enough chart data points yet (waiting for at least 2 intervals).');
        }

        const fileName = 'hashrate-chart.png';
        const container = new ContainerBuilder()
            .setAccentColor(0xf59e0b)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📈 ${title}`))
            .addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL(`attachment://${fileName}`)
                )
            )
            .addActionRowComponents(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`hashsolo:refresh:chart:${address ?? ''}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary)
                )
            );

        return {
            components: [container],
            files: [new AttachmentBuilder(png, { name: fileName })],
            flags: MessageFlags.IsComponentsV2,
        };
    }

    private async sendToChannel(payload: V2Payload): Promise<void> {
        if (this.bot == null || !this.guildId || !this.channelId) {
            return;
        }
        try {
            const guild = await this.bot.guilds.fetch(this.guildId);
            const channel = await guild.channels.fetch(this.channelId) as TextChannel;
            await channel.send(payload as any);
        } catch (error) {
            console.error('Discord send failed:', error);
        }
    }

    private async formatMentionLine(address: string): Promise<string> {
        const subs = await this.discordSubscriptionsService.getSubscriptions(address);
        if (!subs.length) return '';
        const uniqueUsers = Array.from(new Set(subs.map((s) => `<@${s.discordUserId}>`)));
        return `\n${uniqueUsers.join(' ')}`;
    }

    public async notifyRestarted() {
        if (this.bot == null) return;
        const container = new ContainerBuilder()
            .setAccentColor(0x3b82f6)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 🔄 HashSolo Pool Started'),
                new TextDisplayBuilder().setContent('The pool backend is back online and accepting Stratum connections.')
            );
        await this.sendToChannel({ components: [container], flags: MessageFlags.IsComponentsV2 });
    }

    public async notifySubscribersBlockFound(address: string, height: number, block: Block, message: string) {
        if (this.bot == null) return;
        const mentions = await this.formatMentionLine(address);
        const container = new ContainerBuilder()
            .setAccentColor(0xf59e0b)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 🎉 BLOCK FOUND!'),
                new TextDisplayBuilder().setContent(
                    `**Height:** \`${height.toLocaleString('en-US')}\`\n**Address:** \`${this.maskAddress(address)}\`\n**Result:** ${message}${mentions}`
                )
            )
            .addActionRowComponents(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setLabel('View on mempool.space').setURL(`https://mempool.space/block/${height}`).setStyle(ButtonStyle.Link)
                )
            );
        await this.sendToChannel({ components: [container], flags: MessageFlags.IsComponentsV2 });
    }

    public async notifySubscribersBestDifficulty(address: string, worker: string, difficulty: number, userAgent?: string) {
        if (this.bot == null) return;
        const mentions = await this.formatMentionLine(address);
        const device = userAgent ? ` (${userAgent})` : '';
        const container = new ContainerBuilder()
            .setAccentColor(0xeab308)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 🏆 New Best Difficulty'),
                new TextDisplayBuilder().setContent(
                    `**Worker:** \`${worker}\`${device}\n**Address:** \`${this.maskAddress(address)}\`\n**Difficulty:** \`${this.formatDiff(difficulty)}\`${mentions}`
                )
            );
        await this.sendToChannel({ components: [container], flags: MessageFlags.IsComponentsV2 });
    }

    public async notifyWorkerStatus(address: string, worker: string, status: 'online' | 'offline', userAgent?: string) {
        if (this.bot == null) return;
        const mentions = await this.formatMentionLine(address);
        const device = userAgent ? ` (${userAgent})` : '';
        const isOnline = status === 'online';
        const container = new ContainerBuilder()
            .setAccentColor(isOnline ? 0x22c55e : 0xef4444)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(isOnline ? '## 🟢 Worker Online' : '## 🔴 Worker Offline'),
                new TextDisplayBuilder().setContent(
                    `**Worker:** \`${worker}\`${device}\n**Address:** \`${this.maskAddress(address)}\`${mentions}`
                )
            );
        await this.sendToChannel({ components: [container], flags: MessageFlags.IsComponentsV2 });
    }
}
