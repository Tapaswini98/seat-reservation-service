import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReservationStatus } from '../../../shared/enums/reservation.enum';

export class ReservationResponseDto {
  @ApiProperty({ example: '77f6f301-5e72-4aef-9cb4-3e202bf30d63' })
  reservation_id!: string;

  @ApiProperty({ example: '29e30a8c-82d7-4a1e-bc00-3457b18fecf9' })
  show_id!: string;

  @ApiProperty({
    example: 'alice',
    description:
      'Always the JWT subject. A `user_id` sent in the request body is ' +
      'stripped and ignored.',
  })
  user_id!: string;

  @ApiProperty({ example: ['A12'], type: [String] })
  seats!: string[];

  @ApiProperty({
    example: 25000,
    description:
      'Integer minor units (paise): price_paise x seat count. Never a float.',
  })
  amount_paise!: number;

  @ApiProperty({ enum: ReservationStatus, example: ReservationStatus.Confirmed })
  status!: ReservationStatus;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Set only for holds; null once confirmed.',
  })
  expires_at!: string | null;

  @ApiProperty({ example: '2026-10-02T04:25:13.648Z' })
  created_at!: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Present only when this response replays an earlier request that used ' +
      'the same idempotency key. No new reservation was created.',
  })
  idempotent_replay?: boolean;
}
