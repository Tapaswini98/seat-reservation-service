import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../../shared/enums/auth.enum';

export class IssuedTokenDto {
  @ApiProperty({ example: 'alice' })
  user_id!: string;

  @ApiProperty({ enum: UserRole, example: UserRole.User })
  role!: UserRole;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'Paste into the Authorize dialog to call the secured endpoints.',
  })
  token!: string;

  @ApiProperty({ example: '24h' })
  expires_in!: string;
}

export class BulkTokensResponseDto {
  @ApiProperty({ example: 5000 })
  count!: number;

  @ApiProperty({ type: [IssuedTokenDto] })
  tokens!: IssuedTokenDto[];
}
