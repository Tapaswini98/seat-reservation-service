import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { ReserveSeatsDto } from './dto/reserve-seats.dto';
import { ReservationView } from './interfaces';
import { ReservationService } from './reservation.service';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../shared/decorators/current-user.decorator';

@Controller()
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  @Post('shows/:showId/reserve')
  @HttpCode(201)
  reserve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('showId') showId: string,
    @Body() dto: ReserveSeatsDto,
    @Headers('idempotency-key') headerKey?: string,
  ): Promise<ReservationView> {
    // `user.userId` comes from the verified JWT. There is no code path by
    // which a body field can influence it.
    return this.reservationService.reserve(user.userId, showId, dto, headerKey);
  }

  @Get('reservations/:id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') reservationId: string,
  ): Promise<ReservationView> {
    return this.reservationService.findOne(reservationId, user.userId);
  }

  @Post('reservations/:id/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') reservationId: string,
  ): Promise<ReservationView> {
    return this.reservationService.confirm(reservationId, user.userId);
  }

  @Post('reservations/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') reservationId: string,
  ): Promise<ReservationView> {
    return this.reservationService.cancel(reservationId, user.userId);
  }
}
