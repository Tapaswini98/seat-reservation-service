import { Controller, Get, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { FastifyReply } from 'fastify';
import { DataSource } from 'typeorm';
import { Public } from '../auth/public.decorator';
import { log } from '../common/logging/logger';

const READINESS_TIMEOUT_MS = 1000;
/** Readiness is polled far more often than the DB can change state. */
const READINESS_CACHE_MS = 500;

interface Cached {
  at: number;
  ready: boolean;
  latencyMs: number;
  error?: string;
}

@Controller()
export class HealthController {
  private cached: Cached | null = null;
  private readonly bootedAt = Date.now();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Liveness. Answers "is this process still running the event loop?" and
   * nothing else. It must never touch the database: if it did, a database
   * blip would make the orchestrator kill a perfectly healthy process and
   * turn a dependency outage into an outage plus a restart loop.
   */
  @Public()
  @Get(['healthz', 'health/live'])
  live(): { status: string; uptime_s: number } {
    return {
      status: 'ok',
      uptime_s: Math.floor((Date.now() - this.bootedAt) / 1000),
    };
  }

  /**
   * Readiness. Actually executes a query and FAILS CLOSED with 503 when the
   * database is unreachable, so the load balancer stops sending us traffic we
   * could only answer with an error.
   */
  @Public()
  @Get(['readyz', 'health/ready'])
  async ready(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const result = await this.checkDatabase();
    reply.status(result.ready ? 200 : 503);
    return {
      status: result.ready ? 'ready' : 'not_ready',
      checks: {
        database: {
          status: result.ready ? 'up' : 'down',
          latency_ms: result.latencyMs,
          ...(result.error ? { error: result.error } : {}),
        },
      },
    };
  }

  private async checkDatabase(): Promise<Cached> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < READINESS_CACHE_MS) {
      return this.cached;
    }

    const startedAt = Date.now();
    try {
      if (!this.dataSource.isInitialized) {
        throw new Error('data source not initialised');
      }
      await withTimeout(this.dataSource.query('SELECT 1'), READINESS_TIMEOUT_MS);
      this.cached = { at: now, ready: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log({ err: message }).warn('readiness check failed');
      this.cached = {
        at: now,
        ready: false,
        latencyMs: Date.now() - startedAt,
        error: message,
      };
    }
    return this.cached;
  }
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
