import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { FastifyReply } from 'fastify';
import { DataSource } from 'typeorm';
import { Public } from '../../shared/decorators/public.decorator';
import { log } from '../../shared/logger/logger';

const READINESS_TIMEOUT_MS = 1000;
/** Readiness is polled far more often than the database can change state. */
const READINESS_CACHE_MS = 500;

interface ReadinessResult {
  checkedAt: number;
  ready: boolean;
  latencyMs: number;
  error?: string;
}

@ApiTags('Health')
@Controller()
export class HealthController {
  private cached: ReadinessResult | null = null;
  private readonly bootedAt = Date.now();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Liveness. Answers "is this process still turning the event loop?" and
   * nothing else. It must never touch the database: if it did, a database
   * blip would make the orchestrator kill a perfectly healthy process and
   * turn a dependency outage into an outage plus a restart loop.
   */
  @ApiOperation({
    summary: 'Liveness',
    description:
      'Never touches the database: a dependency blip must not get a healthy ' +
      'process killed and turn an outage into a restart loop.',
  })
  @ApiResponse({ status: 200, description: 'Process is alive' })
  @Public()
  @Get(['healthz', 'health/live'])
  live(): { status: string; uptime_s: number } {
    return {
      status: 'ok',
      uptime_s: Math.floor((Date.now() - this.bootedAt) / 1000),
    };
  }

  /**
   * Readiness. Executes a real query and FAILS CLOSED with 503 when the
   * database is unreachable, so the load balancer stops sending us traffic we
   * could only answer with an error.
   */
  @ApiOperation({
    summary: 'Readiness',
    description:
      'Executes a real query and fails closed with 503 when the database is ' +
      'unreachable, so the load balancer stops routing to this instance.',
  })
  @ApiResponse({ status: 200, description: 'Database reachable' })
  @ApiResponse({ status: 503, description: 'Database unreachable' })
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

  private async checkDatabase(): Promise<ReadinessResult> {
    const now = Date.now();
    if (this.cached && now - this.cached.checkedAt < READINESS_CACHE_MS) {
      return this.cached;
    }

    const startedAt = Date.now();
    try {
      if (!this.dataSource.isInitialized) {
        throw new Error('data source not initialised');
      }
      await withTimeout(this.dataSource.query('SELECT 1'), READINESS_TIMEOUT_MS);
      this.cached = {
        checkedAt: now,
        ready: true,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log({ err: message }).warn('readiness check failed');
      this.cached = {
        checkedAt: now,
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
