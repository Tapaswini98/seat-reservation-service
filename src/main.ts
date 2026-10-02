import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
loadEnv();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { loadConfig } from './config/configuration';
import { MetricsService } from './modules/metrics/metrics.service';
import { DomainException } from './shared/exceptions/domain.exception';
import { nestLoggerAdapter, rootLogger } from './shared/logger/logger';
import { registerFastifyHooks } from './shared/middlewares/fastify-hooks';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  // Fastify's own request logging stays off: correlation ids, sampling and
  // metrics all come from our hooks, which see every reply including the ones
  // the exception filter writes.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false,
      bodyLimit: 1024 * 1024,
      trustProxy: true,
    }),
    { logger: nestLoggerAdapter, bufferLogs: false },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      // whitelist strips unknown properties; forbidNonWhitelisted stays FALSE
      // so a body carrying `user_id` is silently ignored and the request runs
      // as the token's subject, which is the required behaviour.
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors) =>
        DomainException.validation('Request validation failed', {
          violations: errors.flatMap((error) =>
            Object.values(error.constraints ?? {}).map(
              (message) => `${error.property}: ${message}`,
            ),
          ),
        }),
    }),
  );

  const instance = app.getHttpAdapter().getInstance();
  registerFastifyHooks(instance, app.get(MetricsService));
  app.enableShutdownHooks();

  const server = instance.server;
  // Render and most load balancers reuse connections aggressively; a
  // keepAliveTimeout below the proxy's produces spurious 502s under load.
  server.keepAliveTimeout = 72_000;
  server.headersTimeout = 75_000;
  server.requestTimeout = 30_000;
  server.maxRequestsPerSocket = 0;

  await app.listen({ port: config.port, host: '0.0.0.0' });
  rootLogger.info(
    {
      port: config.port,
      env: config.env,
      pool_max: config.database.poolMax,
      per_user_limit: config.domain.defaultPerUserLimit,
    },
    'seat-reservation-service listening',
  );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      rootLogger.info({ signal }, 'shutting down');
      void app.close().then(
        () => process.exit(0),
        (err) => {
          rootLogger.error({ err: String(err) }, 'shutdown failed');
          process.exit(1);
        },
      );
    });
  }
}

process.on('unhandledRejection', (reason) => {
  rootLogger.error({ reason: String(reason) }, 'unhandled rejection');
});
process.on('uncaughtException', (err) => {
  rootLogger.fatal({ err: err.stack ?? String(err) }, 'uncaught exception');
  process.exit(1);
});

void bootstrap();
