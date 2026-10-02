import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';
import { Public } from '../../shared/decorators/public.decorator';

@ApiTags('Metrics')
@Controller()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @ApiOperation({
    summary: 'Prometheus metrics',
    description:
      'Seat gauges are derived from the database at scrape time rather than ' +
      'incremented alongside writes, so they reconcile with GET /shows/{id} ' +
      'by construction.',
  })
  @ApiResponse({ status: 200, description: 'Prometheus text exposition format' })
  @Public()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metricsService.scrape();
  }
}
