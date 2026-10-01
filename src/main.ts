import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
loadEnv();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { loadConfig } from './config/configuration';
import { registerHooks } from './common/fastify-hooks';
import { DomainError } from './common/errors/domain-error';
import { nestLoggerAdapter, rootLogger } from './common/logging/logger';
import { MetricsService } from './metrics/metrics.service';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();

  const adapter = new FastifyAdapter({
    // Fastify generates its own ids by default; ours come from the inbound
    // x-request-id when the caller supplies one, so tracing survives the hop.
    genReqId: () => '',
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: nestLoggerAdapter,
    bufferLogs: false,
  });

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
        DomainError.validation('Request validation failed', {
          violations: errors.flatMap((e) =>
            Object.values(e.constraints ?? {}).map((m) => `${e.property}: ${m}`),
          ),
        }),
    }),
  );

  const instance = app.getHttpAdapter().getInstance();
  registerHooks(instance, app.get(MetricsService));

  app.enableShutdownHooks();

  const server = instance.server;
  // Render and most load balancers reuse connections aggressively; a
  // keepAliveTimeout below the proxy's produces spurious 502s under load.
  server.keepAliveTimeout = 72_000;
  server.headersTimeout = 75_000;
  server.requestTimeout = 30_000;
  server.maxRequestsPerSocket = 0;

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  rootLogger.info(
    {
      port: cfg.port,
      env: cfg.env,
      pool_max: cfg.database.poolMax,
      per_user_limit: cfg.domain.defaultPerUserLimit,
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
