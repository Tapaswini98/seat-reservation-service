import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Note what is NOT declared here: `user_id`.
 *
 * The ValidationPipe runs with { whitelist: true, forbidNonWhitelisted: false },
 * so a request that tries to act as somebody else by putting `user_id` in the
 * body has that field silently stripped and is then executed as the token's
 * subject. Stripping rather than rejecting is deliberate: a 400 would confirm
 * to an attacker that the field is recognised, and the requirement is that a
 * spoofed identity can only ever act as the token's user, not that it errors.
 */
export class ReserveSeatsDto {
  @ApiProperty({
    example: ['A12'],
    type: [String],
    description:
      'Seat labels to reserve. All-or-nothing: if any one is unavailable, ' +
      'none are reserved and the response names the seats that blocked it.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  @Matches(/^[A-Za-z0-9._-]+$/, { each: true })
  seats!: string[];

  @ApiPropertyOptional({
    example: 'order-7f3c9a21',
    description:
      'Alternative to the Idempotency-Key header, which takes precedence. ' +
      'The same key with a different body is rejected with 409.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotency_key?: string;

  /**
   * Absent  -> seats go straight to `confirmed` (the default sale path).
   * Present -> seats go to `held` with this TTL and must be confirmed before
   *            the expiry sweeper releases them.
   */
  @ApiPropertyOptional({
    example: 120,
    minimum: 1,
    maximum: 900,
    description:
      'Omit to confirm the seats outright. Supply a TTL to create a ' +
      'time-boxed hold instead, which must be confirmed via ' +
      'POST /reservations/{id}/confirm before the sweeper releases it.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? undefined
      : Number.parseInt(String(value), 10),
  )
  @IsInt()
  @Min(1)
  @Max(900)
  hold_seconds?: number;
}
