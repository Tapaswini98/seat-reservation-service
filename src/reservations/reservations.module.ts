import { Module } from '@nestjs/common';
import { ExpiryService } from './expiry.service';
import { IdempotencyService } from './idempotency.service';
import { ReservationsController } from './reservations.controller';
import { ReservationsRepository } from './reservations.repository';
import { ReservationsService } from './reservations.service';

@Module({
  controllers: [ReservationsController],
  providers: [
    ReservationsService,
    ReservationsRepository,
    IdempotencyService,
    ExpiryService,
  ],
  exports: [ReservationsService, ReservationsRepository, IdempotencyService],
})
export class ReservationsModule {}
