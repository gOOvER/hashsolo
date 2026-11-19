import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import { firstValueFrom } from 'rxjs';

import { AddressSettingsService } from './ORM/address-settings/address-settings.service';
import { BlocksService } from './ORM/blocks/blocks.service';
import { ClientStatisticsService } from './ORM/client-statistics/client-statistics.service';
import { ClientService } from './ORM/client/client.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';

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

    const data = {
      blockData,
      userAgents,
      highScores,
      uptime: this.uptime,
      fee: this.getPoolFeePercent()
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
    const blockHeight = (await firstValueFrom(this.bitcoinRpcService.newBlock$)).blocks;
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
    const miningInfo = await firstValueFrom(this.bitcoinRpcService.newBlock$);
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
  public async metrics(): Promise<string> {
    const [userAgents, blocksFound, nodeInfo, networkInfo] = await Promise.all([
      this.clientService.getUserAgents(),
      this.blocksService.getFoundBlocks(),
      this.bitcoinRpcService.getBlockchainInfo(),
      this.bitcoinRpcService.getNetworkInfo()
    ]);

    const totalHashRate = userAgents.reduce((acc, ua) => acc + (parseFloat(ua.totalHashRate) || 0), 0);
    const totalMiners = userAgents.reduce((acc, ua) => acc + (parseInt(ua.count, 10) || 0), 0);
    const uptimeSeconds = Math.floor((Date.now() - this.uptime.getTime()) / 1000);
    const reward = this.bitcoinRpcService.getNextBlockReward();

    const lines = [
      '# HELP hashsolo_uptime_seconds Pool uptime in seconds',
      '# TYPE hashsolo_uptime_seconds gauge',
      `hashsolo_uptime_seconds ${uptimeSeconds}`,
      '# HELP hashsolo_miners_connected Currently connected miner workers',
      '# TYPE hashsolo_miners_connected gauge',
      `hashsolo_miners_connected ${totalMiners}`,
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
      `hashsolo_next_block_reward_sats ${reward?.rewardSats ?? 0}`
    ];

    return `${lines.join('\n')}\n`;
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
