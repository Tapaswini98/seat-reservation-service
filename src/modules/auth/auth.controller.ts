import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { IssueBulkTokensDto, IssueTokenDto } from './dto/issue-token.dto';
import { IssuedToken } from './interfaces';
import { Public } from '../../shared/decorators/public.decorator';
import { UserRole } from '../../shared/enums/auth.enum';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
