import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { loadConfig } from '../../config/configuration';
import { AuthService } from '../../modules/auth/auth.service';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { IS_ADMIN_KEY, IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { UserRole } from '../enums/auth.enum';
import { setContextUser } from '../logger/request-context';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly config = loadConfig();

  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const adminOnly =
      this.reflector.getAllAndOverride<boolean>(IS_ADMIN_KEY, targets) ?? false;

    // A static admin token is accepted on admin routes so a show can be
    // created from a shell script without first minting a JWT.
    const adminHeader = request.headers['x-admin-token'];
    if (adminOnly && typeof adminHeader === 'string' && adminHeader.length > 0) {
      if (!timingSafeEquals(adminHeader, this.config.auth.adminToken)) {
        throw new ForbiddenException('Invalid admin token');
      }
      request.user = { userId: 'admin', role: UserRole.Admin };
      setContextUser('admin');
      return true;
    }

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let claims;
    try {
      claims = this.authService.verify(header.slice('Bearer '.length).trim());
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (adminOnly && claims.role !== UserRole.Admin) {
      throw new ForbiddenException('Admin role required');
    }

    request.user = { userId: claims.sub, role: claims.role };
    setContextUser(claims.sub);
    return true;
  }
}

/** Constant-time compare, so the admin token cannot be guessed byte by byte. */
const timingSafeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};
