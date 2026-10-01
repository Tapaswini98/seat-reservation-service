import { ExecutionContext, createParamDecorator } from '@nestjs/common';

export interface AuthenticatedUser {
  userId: string;
  role: 'user' | 'admin';
}

/**
 * The ONLY way a handler learns who is calling. Nothing reads a user id from
 * the request body -- see ReserveSeatsDto for why a spoofed body field is
 * ignored rather than rejected.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!request.user) {
      throw new Error('CurrentUser used on a route without JwtAuthGuard');
    }
    return request.user;
  },
);
