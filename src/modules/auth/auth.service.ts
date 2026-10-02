import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../config/configuration';
import { IssuedToken, TokenClaims } from './interfaces';
import { UserRole } from '../../shared/enums/auth.enum';

/**
 * A deliberately thin identity shim.
 *
 * There is no user table, no password and no lookup on the hot path: a load
 * generator needs to mint tens of thousands of identities cheaply, and a
 * bcrypt round per buyer would dominate the burst. What matters for this
 * service -- and what is real -- is that identity is derived from a *signed
 * token* and can never be asserted by the request body.
 */
@Injectable()
export class AuthService {
  private readonly config = loadConfig();

  constructor(private readonly jwtService: JwtService) {}

  issue(userId?: string, role: UserRole = UserRole.User): IssuedToken {
    const sub = userId?.trim() || `user-${randomUUID()}`;
    const token = this.jwtService.sign({ sub, role } satisfies TokenClaims);

    return {
      user_id: sub,
      role,
      token,
      expires_in: this.config.auth.jwtExpiresIn,
    };
  }

  issueBulk(count: number, prefix = 'burst'): IssuedToken[] {
    const batchId = randomUUID().slice(0, 8);
    return Array.from({ length: count }, (_, index) =>
      this.issue(`${prefix}-${batchId}-${index}`, UserRole.User),
    );
  }

  verify(token: string): TokenClaims {
    return this.jwtService.verify<TokenClaims>(token);
  }
}
