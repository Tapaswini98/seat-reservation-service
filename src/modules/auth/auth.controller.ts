import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BulkTokensResponseDto, IssuedTokenDto } from './dto/issued-token.dto';
import { AuthService } from './auth.service';
import { IssueBulkTokensDto, IssueTokenDto } from './dto/issue-token.dto';
import { IssuedToken } from './interfaces';
import { Public } from '../../shared/decorators/public.decorator';
import { UserRole } from '../../shared/enums/auth.enum';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiOperation({
    summary: 'Mint a JWT for a user',
    description:
      'Development identity shim: no user store, no password, so a load ' +
      'generator can mint identities cheaply. What is real is that identity ' +
      'is derived from a signed token and can never be asserted by a body ' +
      'field. Copy the token into the Authorize dialog above.',
  })
  @ApiResponse({ status: 200, type: IssuedTokenDto })
  @Public()
  @Post('token')
  @HttpCode(200)
  issue(@Body() dto: IssueTokenDto): IssuedToken {
    return this.authService.issue(dto.user_id, dto.role ?? UserRole.User);
  }

  /**
   * Bulk minting exists so a load generator does not have to spend 20,000
   * round trips acquiring identities before it can start the actual burst.
   */
  @ApiOperation({
    summary: 'Mint many tokens at once',
    description:
      'So a load generator does not spend 20,000 round trips acquiring ' +
      'identities before the burst starts.',
  })
  @ApiResponse({ status: 200, type: BulkTokensResponseDto })
  @Public()
  @Post('tokens/bulk')
  @HttpCode(200)
  issueBulk(@Body() dto: IssueBulkTokensDto): {
    count: number;
    tokens: IssuedToken[];
  } {
    const tokens = this.authService.issueBulk(dto.count, dto.prefix);
    return { count: tokens.length, tokens };
  }
}
