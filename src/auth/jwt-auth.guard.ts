import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { loadConfig } from '../config/configuration';
import { setContextUser } from '../common/logging/request-context';
import { AuthService } from './auth.service';
import { AuthenticatedUser } from './current-user.decorator';
import { IS_ADMIN_KEY, IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly cfg = loadConfig();

  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
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

    // A static admin token is accepted for admin routes so the show can be
    // created from a shell script without first minting a JWT.
    const adminHeader = request.headers['x-admin-token'];
    if (adminOnly && typeof adminHeader === 'string' && adminHeader.length > 0) {
      if (timingSafeEqual(adminHeader, this.cfg.auth.adminToken)) {
        request.user = { userId: 'admin', role: 'admin' };
        setContextUser('admin');
        return true;
      }
      throw new ForbiddenException('Invalid admin token');
    }

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let claims;
    try {
      claims = this.auth.verify(header.slice('Bearer '.length).trim());
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (adminOnly && claims.role !== 'admin') {
      throw new ForbiddenException('Admin role required');
    }

    request.user = { userId: claims.sub, role: claims.role };
    setContextUser(claims.sub);
    return true;
  }
}

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};
