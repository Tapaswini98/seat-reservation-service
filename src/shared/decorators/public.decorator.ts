import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';
export const IS_ADMIN_KEY = 'auth:admin';

/** Opts a route out of the globally-applied JwtAuthGuard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const AdminOnly = () => SetMetadata(IS_ADMIN_KEY, true);
