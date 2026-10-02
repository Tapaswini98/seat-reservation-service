import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

/**
 * Binds the context to the current async resource and everything continuing
 * from it. Used from a Fastify `onRequest` hook, where wrapping the rest of
 * the lifecycle in a callback is not possible.
 */
export const enterRequestContext = (context: RequestContext): void => {
  storage.enterWith(context);
};

export const getRequestContext = (): RequestContext | undefined => storage.getStore();

export const getRequestId = (): string | undefined => storage.getStore()?.requestId;

export const setContextUser = (userId: string): void => {
  const context = storage.getStore();
  if (context) context.userId = userId;
};
