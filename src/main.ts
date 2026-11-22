import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as bitcoinjs from 'bitcoinjs-lib';
import { useContainer } from 'class-validator';
import { readFileSync } from 'fs';
import * as ecc from 'tiny-secp256k1';

import { AppController } from './app.controller';
import { AppModule } from './app.module';
import {
  getNonNegativeIntEnv,
  isAuthorizedMetricsRequest,
  SlidingWindowRateLimiter,
} from './services/stratum-rate-limit.util';

async function bootstrap() {

  if (process.env.API_PORT == null) {
    console.error('It appears your environment is not configured, create and populate an .env file.');
    return;
  }

  let options = {};
  const secure = process.env.API_SECURE?.toLowerCase() == 'true';
  if (secure) {
    const currentDirectory = process.cwd();
    options = {
      https: {
        key: readFileSync(`${currentDirectory}/secrets/key.pem`),
        cert: readFileSync(`${currentDirectory}/secrets/cert.pem`),
      }
    };
  }

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(options));
  app.setGlobalPrefix('api');

  // Optional HTTP API rate limiting (exempts /metrics & /api/metrics for Prometheus scraping)
  const apiRateLimitMax = getNonNegativeIntEnv(process.env.API_RATE_LIMIT_MAX, 120);
  const apiRateLimitWindowMs = getNonNegativeIntEnv(process.env.API_RATE_LIMIT_WINDOW_MS, 60_000);
  const fastify = app.getHttpAdapter().getInstance();

  if (apiRateLimitMax > 0 && apiRateLimitWindowMs > 0) {
    const rateLimiter = new SlidingWindowRateLimiter(apiRateLimitMax, apiRateLimitWindowMs);
    fastify.addHook('onRequest', async (req, reply) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/metrics' || path === '/api/metrics') {
        return;
      }
      const result = rateLimiter.consume(req.ip ?? req.socket?.remoteAddress);
      if (!result.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAtMs - Date.now()) / 1000));
        reply.header('Retry-After', String(retryAfterSeconds));
        return reply.code(429).send({
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Rate limit exceeded',
        });
      }
    });
  }

  // Expose standard Prometheus /metrics alias alongside /api/metrics
  const appController = app.get(AppController);
  fastify.get('/metrics', async (req, reply) => {
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    if (!isAuthorizedMetricsRequest(authHeader, process.env.METRICS_BEARER_TOKEN)) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid or missing metrics bearer token',
      });
    }
    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(await appController.metrics(authHeader));
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      //forbidNonWhitelisted: true,
      //forbidUnknownValues: true
    }),
  );

  app.enableShutdownHooks();

  const shutdown = async () => {
    console.log('Stopping services');
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : true,
  });
  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  //Taproot
  bitcoinjs.initEccLib(ecc);

  await app.listen(process.env.API_PORT, '0.0.0.0', (err, address) => {
    console.log(`API listening on ${address}`);
  });

}

bootstrap();
