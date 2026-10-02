import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { UserRole } from '../../../shared/enums/auth.enum';

export class IssueTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'user_id may contain letters, digits and . _ : - only',
  })
  user_id?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

export class IssueBulkTokensDto {
  @Transform(({ value }) => Number.parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  @Max(50000)
  count!: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9._-]+$/)
  prefix?: string;
}
