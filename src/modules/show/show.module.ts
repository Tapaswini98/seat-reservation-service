import { Module } from '@nestjs/common';
import { ShowRepository } from '../../models/repositories';
import { ShowController } from './show.controller';
import { ShowService } from './show.service';

@Module({
  controllers: [ShowController],
  providers: [ShowService, ShowRepository],
  exports: [ShowService, ShowRepository],
})
export class ShowModule {}
