import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ReservationResponseDto } from './dto/reservation-response.dto';
import { ErrorResponseDto } from '../../shared/dtos/error-response.dto';
import { ReserveSeatsDto } from './dto/reserve-seats.dto';
import { ReservationView } from './interfaces';
import { ReservationService } from './reservation.service';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../shared/decorators/current-user.decorator';

@ApiTags('Reservations')
@ApiBearerAuth()
@Controller()
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  @ApiOperation({
    summary: 'Reserve seats',
    description:
      'Atomically allocates every requested seat or none of them. Identity ' +
      'comes from the bearer token; a `user_id` in the body is ignored. ' +
      'Supply `hold_seconds` to create a time-boxed hold instead of an ' +
      'immediate confirmation.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Retrying with the same key returns the original reservation. The ' +
      'same key with a different body is rejected with 409.',
  })
  @ApiResponse({
    status: 201,
    description:
      'Reserved. Also returned for an idempotent replay, with ' +
      '`idempotent_replay: true` and no new reservation created.',
    type: ReservationResponseDto,
  })
  @ApiResponse({
    status: 409,
    description:
      'Declined: seat_taken, per_user_limit, idempotency_key_reuse or ' +
      'request_in_flight. A decline is a business outcome, never an error.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown show or seat',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 422,
    description: 'Validation failed',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 429,
    description: 'Pool saturated; retry',
    type: ErrorResponseDto,
  })
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

  @ApiOperation({
    summary: 'Fetch your own reservation',
    description:
      'A non-owner receives 404 rather than 403, so reservation ids cannot ' +
      'be enumerated by probing.',
  })
  @ApiResponse({ status: 200, type: ReservationResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not yours',
    type: ErrorResponseDto,
  })
  @Get('reservations/:id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') reservationId: string,
  ): Promise<ReservationView> {
    return this.reservationService.findOne(reservationId, user.userId);
  }

  @ApiOperation({
    summary: 'Promote a hold to confirmed',
    description: 'Owner only. Fails with 409 if the hold has already expired.',
  })
  @ApiResponse({ status: 200, type: ReservationResponseDto })
  @ApiResponse({
    status: 409,
    description: 'Expired or not held',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not yours',
    type: ErrorResponseDto,
  })
  @Post('reservations/:id/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') reservationId: string,
  ): Promise<ReservationView> {
    return this.reservationService.confirm(reservationId, user.userId);
  }

  @ApiOperation({
    summary: 'Cancel your reservation and release its seats',
    description:
      'Owner only, and idempotent. Release is guarded on the reservation id, ' +
      'so a late cancel can never free a seat already sold to someone else.',
  })
  @ApiResponse({ status: 200, type: ReservationResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not yours',
    type: ErrorResponseDto,
  })
  @Post('reservations/:id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') reservationId: string,
  ): Promise<ReservationView> {
    return this.reservationService.cancel(reservationId, user.userId);
  }
}
