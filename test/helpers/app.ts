import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { registerHooks } from '../../src/common/fastify-hooks';
import { DomainError } from '../../src/common/errors/domain-error';
import { MetricsService } from '../../src/metrics/metrics.service';

export interface TestApp {
  baseUrl: string;
  dataSource: DataSource;
  close: () => Promise<void>;
}

/**
 * Boots the real application over a real Fastify socket rather than using
 * supertest. The interesting tests fire hundreds of genuinely parallel
 * requests, and that only measures anything if they travel over TCP into one
 * shared process the way they will in production.
 */
export const startTestApp = async (): Promise<TestApp> => {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: true }),
    { logger: false },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
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

  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = await app.getUrl();

  return {
    baseUrl: url.replace('[::1]', '127.0.0.1'),
    dataSource: app.get(DataSource),
    close: async () => {
      await app.close();
    },
  };
};

export const resetDatabase = async (ds: DataSource): Promise<void> => {
  await ds.query(
    `TRUNCATE reservation_seats, reservations, seats, shows, idempotency_keys RESTART IDENTITY CASCADE`,
  );
};
