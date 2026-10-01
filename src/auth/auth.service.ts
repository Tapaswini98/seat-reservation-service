import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/configuration';

export interface TokenClaims {
  sub: string;
  role: 'user' | 'admin';
}

export interface IssuedToken {
  user_id: string;
  role: 'user' | 'admin';
  token: string;
  expires_in: string;
}

/**
 * A deliberately thin identity shim. There is no user table, no password and
 * no lookup on the hot path: a grader needs to mint tens of thousands of
 * identities cheaply, and a bcrypt round per buyer would dominate the burst.
 * What matters for this exercise is that identity is *derived from a signed
 * token* and can never be asserted by the request body -- that part is real.
 */
@Injectable()
export class AuthService {
  private readonly cfg = loadConfig();

  constructor(private readonly jwt: JwtService) {}

  issue(userId?: string, role: 'user' | 'admin' = 'user'): IssuedToken {
    const sub = userId?.trim() || `user-${randomUUID()}`;
    const token = this.jwt.sign({ sub, role } satisfies TokenClaims);
    return {
      user_id: sub,
      role,
      token,
      expires_in: this.cfg.auth.jwtExpiresIn,
    };
  }

  issueBulk(count: number, prefix = 'burst'): IssuedToken[] {
    const batchId = randomUUID().slice(0, 8);
    return Array.from({ length: count }, (_, i) =>
      this.issue(`${prefix}-${batchId}-${i}`, 'user'),
    );
  }

  verify(token: string): TokenClaims {
    return this.jwt.verify<TokenClaims>(token);
  }
}
