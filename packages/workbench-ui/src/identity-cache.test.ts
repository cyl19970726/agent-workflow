import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { discardScopedSpaceData, identityChanged, isAuthDenial, mayDisplaySummary } from './identity-cache.js';

describe('Space identity cache boundary', () => {
  it('does not treat a transient absent summary as a subject change', () => {
    expect(identityChanged('user-a:scope-a', undefined)).toBe(false);
    expect(identityChanged(undefined, 'user-a:scope-a')).toBe(false);
    expect(identityChanged('user-a:scope-a', 'user-a:scope-a')).toBe(false);
    expect(identityChanged('user-a:scope-a', 'user-b:scope-b')).toBe(true);
  });

  it('drops protected queries without deleting the live summary query that drives refresh', () => {
    const client = new QueryClient();
    client.setQueryData(['space-summary', '/api/spaces/s1'], { subject: { id: 'user-b' } });
    client.setQueryData(['space', 'user-a:scope-a', 's1', 'reading', 'asset-a'], { private: true });
    client.setQueryData(['space', 'user-b:scope-b', 's1', 'reading', 'asset-b'], { private: true });
    discardScopedSpaceData(client, 'user-a:scope-a');
    expect(client.getQueryData(['space-summary', '/api/spaces/s1'])).toEqual({ subject: { id: 'user-b' } });
    expect(client.getQueryData(['space', 'user-a:scope-a', 's1', 'reading', 'asset-a'])).toBeUndefined();
    expect(client.getQueryData(['space', 'user-b:scope-b', 's1', 'reading', 'asset-b'])).toEqual({ private: true });
  });

  it('recognizes only authentication denial as a reason to hide cached subject data', () => {
    expect(isAuthDenial({ status: 401 })).toBe(true);
    expect(isAuthDenial({ status: 403 })).toBe(true);
    expect(isAuthDenial({ status: 500 })).toBe(false);
    expect(mayDisplaySummary({ subject: 'same-user' }, { status: 500 }, false)).toBe(true);
    expect(mayDisplaySummary({ subject: 'old-user' }, { status: 403 }, false)).toBe(false);
    expect(mayDisplaySummary({ subject: 'old-user' }, null, true)).toBe(false);
  });
});
