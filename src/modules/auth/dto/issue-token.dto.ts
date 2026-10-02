import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
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
  @ApiPropertyOptional({
    example: 'alice',
    description: 'Omit to be issued a random identity.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'user_id may contain letters, digits and . _ : - only',
  })
  user_id?: string;

  @ApiPropertyOptional({ enum: UserRole, default: UserRole.User })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

export class IssueBulkTokensDto {
  @ApiProperty({ example: 5000, minimum: 1, maximum: 50000 })
  @Transform(({ value }) => Number.parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  @Max(50000)
  count!: number;

  @ApiPropertyOptional({ example: 'burst', default: 'burst' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9._-]+$/)
  prefix?: string;
}
