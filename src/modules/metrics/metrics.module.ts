import { Global, Module } from '@nestjs/common';
import { ShowRepository } from '../../models/repositories';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, ShowRepository],
  exports: [MetricsService],
})
export class MetricsModule {}
