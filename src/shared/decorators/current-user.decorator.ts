import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { UserRole } from '../enums/auth.enum';

export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
}

/**
 * The only way a handler learns who is calling.
 *
 * Nothing anywhere reads a user id from a request body -- see ReserveSeatsDto
 * for why a spoofed `user_id` field is stripped rather than rejected.
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
