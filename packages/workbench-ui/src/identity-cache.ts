import type { QueryClient } from '@tanstack/react-query';

export function identityChanged(previous: string | undefined, current: string | undefined): boolean {
  return previous !== undefined && current !== undefined && previous !== current;
}

export function discardScopedSpaceData(client: QueryClient, previousScope?: string): void {
  client.removeQueries({ predicate: query => query.queryKey[0] === 'space' && (!previousScope || query.queryKey[1] === previousScope) });
}

export function isAuthDenial(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && (error.status === 401 || error.status === 403);
}

export function mayDisplaySummary<T>(cached: T | undefined, error: unknown, blocked: boolean): cached is T {
  return cached !== undefined && !blocked && !isAuthDenial(error);
}
