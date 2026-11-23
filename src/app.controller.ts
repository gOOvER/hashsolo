import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Header, Headers, Inject, MessageEvent, Optional, Sse, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import { firstValueFrom, interval, map, merge, Observable } from 'rxjs';

import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { poolMetrics } from './services/pool-metrics.util';
import { isAuthorizedMetricsRequest } from './services/stratum-rate-limit.util';
import { StratumV2Service } from './services/stratum-v2.service';

@Controller()
export class AppController {

  private uptime = new Date();

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly configService: ConfigService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly blocksService: BlocksService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly addressSettingsService: AddressSettingsService,
    @Optional() private readonly stratumV2Service?: StratumV2Service,
  ) { }

  @Get('info')
  public async info() {


    const CACHE_KEY = 'SITE_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }


    const blockData = await this.blocksService.getFoundBlocks();
    const userAgents = await this.clientService.getUserAgents();
    const highScores = await this.addressSettingsService.getHighScores();

    const sv2PublicKey = this.stratumV2Service?.getAuthorityPublicKey() ?? null;
    const data = {
      blockData,
      userAgents,
      highScores,
      uptime: this.uptime,
      fee: this.getPoolFeePercent(),
      version: '1.2.0',
      network: this.configService.get<string>('NETWORK') || 'mainnet',
      ...(sv2PublicKey
        ? {
            sv2: {
              poolAuthorityPublicKey: sv2PublicKey,
              authorityKeyConfigured: true
            }
          }
        : {})
    };

    //1 min
    await this.cacheManager.set(CACHE_KEY, data, 1 * 60 * 1000);

    return data;

  }

  @Get('info/miners')
  public async connectedMiners() {
    const CACHE_KEY = 'CONNECTED_MINERS';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const miners = await this.clientService.getConnectedMiners();
    await this.cacheManager.set(CACHE_KEY, miners, 15 * 1000);
    return miners;
  }

  @Get('info/accounting')
  public async infoAccounting() {
    const CACHE_KEY = 'SITE_ACCOUNTING';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const [highScores, summary, userAgents] = await Promise.all([
      this.addressSettingsService.getHighScores(),
      this.clientStatisticsService.getAccountingSummary(),
      this.clientService.getUserAgents(),
    ]);

    const best = highScores?.[0];
    const bestSubmissionDifficulty = Number(best?.bestDifficulty) || 0;
    const bestSubmissionDifficultyAt = best?.updatedAt ?? null;
    const liveHashrate = userAgents.reduce((acc, ua) => acc + (parseFloat(ua.totalHashRate) || 0), 0);

    const data = {
      bestSubmissionDifficulty,
      bestSubmissionDifficultyAt,
      totalCreditedDifficulty: summary.totalCreditedDifficulty,
      creditedDifficultyLastHour: summary.creditedDifficultyLastHour,
      creditedDifficultyLast10Minutes: summary.creditedDifficultyLast10Minutes,
      hashRateLast10Minutes: liveHashrate > 0 ? liveHashrate : summary.hashRateLast10Minutes,
      hashRateLastHour: summary.hashRateLastHour > 0 ? summary.hashRateLastHour : liveHashrate,
      networkDifficultyPercent: 0,
    };

    await this.cacheManager.set(CACHE_KEY, data, 15 * 1000);
    return data;
  }

  @Get('pool')
  public async pool() {

    const CACHE_KEY = 'POOL_INFO';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }


    const userAgents = await this.clientService.getUserAgents();
    const totalHashRate = userAgents.reduce((acc, userAgent) => acc + parseFloat(userAgent.totalHashRate), 0);
    const totalMiners = userAgents.reduce((acc, userAgent) => acc + parseInt(userAgent.count), 0);
    const miningInfo = this.bitcoinRpcService.getLatestMiningInfo() ?? await this.bitcoinRpcService.getMiningInfo();
    const blockHeight = miningInfo?.blocks ?? 0;
    const blocksFound = await this.blocksService.getFoundBlocks();

    const data = {
      totalHashRate,
      blockHeight,
      totalMiners,
      blocksFound,
      fee: this.getPoolFeePercent()
    }

    //5 min
    await this.cacheManager.set(CACHE_KEY, data, 5 * 60 * 1000);

    return data;
  }

  @Get('network')
  public async network() {
    const miningInfo = this.bitcoinRpcService.getLatestMiningInfo() ?? await this.bitcoinRpcService.getMiningInfo();
    return miningInfo;
  }

  @Get('info/next-block-reward')
  public nextBlockReward() {
    return this.bitcoinRpcService.getNextBlockReward() ?? {
      rewardSats: 0,
      subsidySats: 0,
      feeSats: 0,
      height: 0
    };
  }

  @Get('node/status')
  public async nodeStatus() {
    const CACHE_KEY = 'BITCOIN_NODE_STATUS';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);
    if (cachedResult != null) {
      return cachedResult;
    }

    const [info, networkInfo] = await Promise.all([
      this.bitcoinRpcService.getBlockchainInfo(),
      this.bitcoinRpcService.getNetworkInfo()
    ]);
    const status = info
      ? {
          reachable: true,
          ready: !info.initialblockdownload && info.blocks > 0,
          chain: info.chain,
          blocks: info.blocks,
          headers: info.headers,
          verificationProgress: info.verificationprogress,
          initialBlockDownload: info.initialblockdownload,
          pruned: info.pruned,
          sizeOnDisk: info.size_on_disk,
          connections: networkInfo?.connections ?? null
        }
      : {
          reachable: false,
          ready: false,
          chain: null,
          blocks: 0,
          headers: 0,
          verificationProgress: 0,
          initialBlockDownload: true,
          pruned: false,
          sizeOnDisk: 0,
          connections: null
        };

    // 3s short cache to protect RPC while keeping live UI updates responsive
    await this.cacheManager.set(CACHE_KEY, status, 3000);
    return status;
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  public async metrics(@Headers('authorization') authHeader?: string): Promise<string> {
    if (!isAuthorizedMetricsRequest(authHeader, this.configService.get<string>('METRICS_BEARER_TOKEN'))) {
      throw new UnauthorizedException('Invalid or missing metrics bearer token');
    }
    const [userAgents, blocksFound, highScores, nodeInfo, networkInfo] = await Promise.all([
      this.clientService.getUserAgents(),
      this.blocksService.getFoundBlocks(),
      this.addressSettingsService.getHighScores(),
      this.bitcoinRpcService.getBlockchainInfo(),
      this.bitcoinRpcService.getNetworkInfo()
    ]);

    const totalHashRate = userAgents.reduce((acc, ua) => acc + (parseFloat(ua.totalHashRate) || 0), 0);
    const totalMiners = userAgents.reduce((acc, ua) => acc + (parseInt(ua.count, 10) || 0), 0);
    const sv2Miners = userAgents
      .filter((ua) => typeof ua.userAgent === 'string' && (ua.userAgent.startsWith('SV2:') || ua.userAgent === 'StratumV2'))
      .reduce((acc, ua) => acc + (parseInt(ua.count, 10) || 0), 0);
    const sv2Enabled = this.stratumV2Service?.getAuthorityPublicKey() ? 1 : 0;
    const topBestDifficulty = Number(highScores?.[0]?.bestDifficulty) || 0;
    const uptimeSeconds = Math.floor((Date.now() - this.uptime.getTime()) / 1000);
    const reward = this.bitcoinRpcService.getNextBlockReward();

    const lines = [
      '# HELP hashsolo_uptime_seconds Pool uptime in seconds',
      '# TYPE hashsolo_uptime_seconds gauge',
      `hashsolo_uptime_seconds ${uptimeSeconds}`,
      '# HELP hashsolo_miners_connected Currently connected miner workers',
      '# TYPE hashsolo_miners_connected gauge',
      `hashsolo_miners_connected ${totalMiners}`,
      '# HELP hashsolo_stratum_v2_miners_connected Currently connected Stratum V2 miner workers',
      '# TYPE hashsolo_stratum_v2_miners_connected gauge',
      `hashsolo_stratum_v2_miners_connected ${sv2Miners}`,
      '# HELP hashsolo_stratum_v2_enabled Whether Stratum V2 listener is active (1=yes, 0=no)',
      '# TYPE hashsolo_stratum_v2_enabled gauge',
      `hashsolo_stratum_v2_enabled ${sv2Enabled}`,
      '# HELP hashsolo_best_difficulty Highest recorded share difficulty on the pool',
      '# TYPE hashsolo_best_difficulty gauge',
      `hashsolo_best_difficulty ${topBestDifficulty}`,
      '# HELP hashsolo_pool_hashrate_hs Total pool hashrate in H/s',
      '# TYPE hashsolo_pool_hashrate_hs gauge',
      `hashsolo_pool_hashrate_hs ${totalHashRate}`,
      '# HELP hashsolo_blocks_found_total Total blocks found by the pool',
      '# TYPE hashsolo_blocks_found_total counter',
      `hashsolo_blocks_found_total ${blocksFound.length}`,
      '# HELP hashsolo_bitcoin_node_reachable Whether bitcoind RPC is reachable (1=yes, 0=no)',
      '# TYPE hashsolo_bitcoin_node_reachable gauge',
      `hashsolo_bitcoin_node_reachable ${nodeInfo ? 1 : 0}`,
      '# HELP hashsolo_bitcoin_node_ready Whether bitcoind has completed IBD (1=yes, 0=no)',
      '# TYPE hashsolo_bitcoin_node_ready gauge',
      `hashsolo_bitcoin_node_ready ${nodeInfo && !nodeInfo.initialblockdownload && nodeInfo.blocks > 0 ? 1 : 0}`,
      '# HELP hashsolo_bitcoin_node_blocks Current synced block height',
      '# TYPE hashsolo_bitcoin_node_blocks gauge',
      `hashsolo_bitcoin_node_blocks ${nodeInfo?.blocks ?? 0}`,
      '# HELP hashsolo_bitcoin_node_headers Known header height',
      '# TYPE hashsolo_bitcoin_node_headers gauge',
      `hashsolo_bitcoin_node_headers ${nodeInfo?.headers ?? 0}`,
      '# HELP hashsolo_bitcoin_node_verification_progress Verification progress ratio (0..1)',
      '# TYPE hashsolo_bitcoin_node_verification_progress gauge',
      `hashsolo_bitcoin_node_verification_progress ${nodeInfo?.verificationprogress ?? 0}`,
      '# HELP hashsolo_bitcoin_node_connections Connected Bitcoin P2P peers',
      '# TYPE hashsolo_bitcoin_node_connections gauge',
      `hashsolo_bitcoin_node_connections ${networkInfo?.connections ?? 0}`,
      '# HELP hashsolo_next_block_reward_sats Next block coinbase reward in satoshis',
      '# TYPE hashsolo_next_block_reward_sats gauge',
      `hashsolo_next_block_reward_sats ${reward?.rewardSats ?? 0}`,
      ...this.buildExtendedMetricsLines()
    ];

    return `${lines.join('\n')}\n`;
  }

  private buildExtendedMetricsLines(): string[] {
    const snap = poolMetrics.getSnapshot();
    return [
      '# HELP hashsolo_shares_accepted_total Total accepted miner shares',
      '# TYPE hashsolo_shares_accepted_total counter',
      `hashsolo_shares_accepted_total ${snap.sharesAcceptedTotal}`,
      '# HELP hashsolo_shares_rejected_total Total rejected miner shares by reason',
      '# TYPE hashsolo_shares_rejected_total counter',
      `hashsolo_shares_rejected_total{reason="stale"} ${snap.sharesRejected.stale}`,
      `hashsolo_shares_rejected_total{reason="duplicate"} ${snap.sharesRejected.duplicate}`,
      `hashsolo_shares_rejected_total{reason="low_diff"} ${snap.sharesRejected.low_diff}`,
      `hashsolo_shares_rejected_total{reason="invalid"} ${snap.sharesRejected.invalid}`,
      '# HELP hashsolo_stratum_connections_rejected_total Total rejected Stratum connections by reason',
      '# TYPE hashsolo_stratum_connections_rejected_total counter',
      `hashsolo_stratum_connections_rejected_total{reason="ip_limit"} ${snap.connectionsRejected.ip_limit}`,
      `hashsolo_stratum_connections_rejected_total{reason="invalid_messages"} ${snap.connectionsRejected.invalid_messages}`,
      `hashsolo_stratum_connections_rejected_total{reason="user_agent"} ${snap.connectionsRejected.user_agent}`,
      '# HELP hashsolo_block_template_age_seconds Age in seconds since last block template was built (-1 if none)',
      '# TYPE hashsolo_block_template_age_seconds gauge',
      `hashsolo_block_template_age_seconds ${snap.templateAgeSeconds}`,
      '# HELP hashsolo_zmq_last_message_seconds Seconds since last Bitcoin ZMQ notification (-1 if none)',
      '# TYPE hashsolo_zmq_last_message_seconds gauge',
      `hashsolo_zmq_last_message_seconds ${snap.zmqLastMessageSeconds}`
    ];
  }

  @Sse('stream')
  public stream(): Observable<MessageEvent> {
    const events$ = poolMetrics.events$.pipe(
      map((event) => ({
        type: event.type,
        data: event,
      }) as MessageEvent),
    );
    const heartbeat$ = interval(15_000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: { timestamp: new Date().toISOString() },
      }) as MessageEvent),
    );
    return merge(events$, heartbeat$);
  }

  private getPoolFeePercent(): number {
    const devFeeAddress = this.configService.get<string>('DEV_FEE_ADDRESS')?.trim();
    return devFeeAddress && devFeeAddress.length > 0 ? 1.5 : 0;
  }

  @Get('info/chart')
  public async infoChart() {


    const CACHE_KEY = 'SITE_HASHRATE_GRAPH';
    const cachedResult = await this.cacheManager.get(CACHE_KEY);

    if (cachedResult != null) {
      return cachedResult;
    }

    const chartData = await this.clientStatisticsService.getChartDataForSite();

    //10 min
    await this.cacheManager.set(CACHE_KEY, chartData, 10 * 60 * 1000);

    return chartData;


  }

}
