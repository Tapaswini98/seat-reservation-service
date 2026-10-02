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
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  @Matches(/^[A-Za-z0-9._-]+$/, { each: true })
  seats!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotency_key?: string;

  /**
   * Absent  -> seats go straight to `confirmed` (the default sale path).
   * Present -> seats go to `held` with this TTL and must be confirmed before
   *            the expiry sweeper releases them.
   */
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
