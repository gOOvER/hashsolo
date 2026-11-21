import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as bitcoinjs from 'bitcoinjs-lib';
import { useContainer } from 'class-validator';
import { readFileSync } from 'fs';
import * as ecc from 'tiny-secp256k1';

import { AppController } from './app.controller';
import { AppModule } from './app.module';

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

  // Expose standard Prometheus /metrics alias alongside /api/metrics
  const appController = app.get(AppController);
  app.getHttpAdapter().getInstance().get('/metrics', async (_req, reply) => {
    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(await appController.metrics());
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
