import { Module } from '@nestjs/common';
import {
  IdempotencyKeyRepository,
  ReservationRepository,
  SeatRepository,
} from '../../models/repositories';
import { ExpiryCronService } from './expiry-cron.service';
import { IdempotencyService } from './idempotency.service';
import { ReservationController } from './reservation.controller';
import { ReservationService } from './reservation.service';

@Module({
  controllers: [ReservationController],
  providers: [
    ReservationService,
    IdempotencyService,
    ExpiryCronService,
    ReservationRepository,
    SeatRepository,
    IdempotencyKeyRepository,
  ],
  exports: [ReservationService, ReservationRepository],
})
export class ReservationModule {}
