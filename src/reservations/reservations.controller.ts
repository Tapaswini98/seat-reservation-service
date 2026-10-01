import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser } from '../auth/current-user.decorator';
import { ReserveSeatsDto } from './dto/reserve-seats.dto';
import { ReservationView } from './reservation.types';
import { ReservationsService } from './reservations.service';

@Controller()
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post('shows/:showId/reserve')
  @HttpCode(201)
  reserve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('showId') showId: string,
    @Body() dto: ReserveSeatsDto,
    @Headers('idempotency-key') headerKey?: string,
  ): Promise<ReservationView> {
    // `user.userId` comes from the verified JWT. There is no code path by which
    // a body field can influence it.
    return this.reservations.reserve(user.userId, showId, dto, headerKey);
  }

  @Get('reservations/:id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ReservationView> {
    return this.reservations.get(id, user.userId);
  }

  @Post('reservations/:id/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ReservationView> {
    return this.reservations.confirm(id, user.userId);
  }

  @Post('reservations/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ReservationView> {
    return this.reservations.cancel(id, user.userId);
  }
}
