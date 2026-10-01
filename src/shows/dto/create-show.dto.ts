import { Transform, Type } from 'class-transformer';
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
  MinLength,
} from 'class-validator';

export class CreateShowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9 ._:-]+$/, {
    message: 'name may contain letters, digits, spaces and . _ : - only',
  })
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20000)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  @Matches(/^[A-Za-z0-9._-]+$/, {
    each: true,
    message: 'seat labels may contain letters, digits and . _ - only',
  })
  seats!: string[];

  /** Integer minor units. Never a float, never parsed from a decimal string. */
  @Type(() => Number)
  @IsInt({ message: 'price_paise must be an integer number of paise' })
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  price_paise!: number;

  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : Number.parseInt(String(value), 10),
  )
  @IsInt()
  @Min(1)
  @Max(1000)
  per_user_limit?: number;
}
