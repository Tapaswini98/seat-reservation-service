import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(ctx: RequestContext, fn: () => T): T =>
  storage.run(ctx, fn);

export const getRequestContext = (): RequestContext | undefined => storage.getStore();

export const getRequestId = (): string | undefined => storage.getStore()?.requestId;

export const setContextUser = (userId: string): void => {
  const ctx = storage.getStore();
  if (ctx) ctx.userId = userId;
};

/**
 * Binds the context to the current async resource and everything that
 * continues from it. Used from a Fastify onRequest hook, where wrapping the
 * remainder of the lifecycle in a callback is not possible.
 */
export const enterRequestContext = (ctx: RequestContext): void => {
  storage.enterWith(ctx);
};
