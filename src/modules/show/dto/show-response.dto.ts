import { ApiProperty } from '@nestjs/swagger';
import { SeatStatus } from '../../../shared/enums/seat.enum';

export class SeatViewDto {
  @ApiProperty({ example: 'A12' })
  seat_number!: string;

  @ApiProperty({ enum: SeatStatus, example: SeatStatus.Available })
  status!: SeatStatus;

  @ApiProperty({ nullable: true, example: null })
  held_until!: string | null;
}

export class SeatCountsDto {
  @ApiProperty({ example: 130 })
  available!: number;

  @ApiProperty({ example: 0 })
  held!: number;

  @ApiProperty({ example: 370 })
  confirmed!: number;

  @ApiProperty({ example: 500 })
  total!: number;
}

export class ShowResponseDto {
  @ApiProperty({ example: '29e30a8c-82d7-4a1e-bc00-3457b18fecf9' })
  id!: string;

  @ApiProperty({ example: 'friday-night' })
  name!: string;

  @ApiProperty({ example: 25000, description: 'Integer minor units (paise) per seat.' })
  price_paise!: number;

  @ApiProperty({ example: 4 })
  per_user_limit!: number;

  @ApiProperty({ example: 500 })
  total_seats!: number;

  @ApiProperty({ type: SeatCountsDto })
  counts!: SeatCountsDto;

  @ApiProperty({
    example: true,
    description:
      'available + held + confirmed == total_seats. Asserted on every call; ' +
      'false means the reconciliation invariant has been violated.',
  })
  reconciled!: boolean;

  @ApiProperty({ type: [SeatViewDto] })
  seats!: SeatViewDto[];
}
