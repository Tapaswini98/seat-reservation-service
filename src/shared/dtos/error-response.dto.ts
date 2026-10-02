import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeclineReason } from '../enums/reservation.enum';

export class ErrorDetailDto {
  @ApiProperty({
    enum: DeclineReason,
    example: DeclineReason.SEAT_TAKEN,
    description:
      'Machine-readable outcome. Stable contract: this is the same value ' +
      'used as the `reason` label on reservations_declined_total.',
  })
  code!: string;

  @ApiProperty({ example: 'Seat(s) already taken: A12' })
  message!: string;

  @ApiPropertyOptional({
    description: 'Reason-specific context, e.g. which seats blocked the request.',
    example: { unavailable_seats: ['A12'] },
  })
  details?: Record<string, unknown>;
}

export class ErrorResponseDto {
  @ApiProperty({ type: ErrorDetailDto })
  error!: ErrorDetailDto;

  @ApiPropertyOptional({
    description: 'Correlation id, also returned in the X-Request-Id header.',
    example: 'a0e34a77-4684-4719-8ba4-b700f21f52a0',
  })
  request_id?: string;
}
