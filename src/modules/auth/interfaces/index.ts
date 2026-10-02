import { UserRole } from '../../../shared/enums/auth.enum';

export interface TokenClaims {
  sub: string;
  role: UserRole;
}

export interface IssuedToken {
  user_id: string;
  role: UserRole;
  token: string;
  expires_in: string;
}
