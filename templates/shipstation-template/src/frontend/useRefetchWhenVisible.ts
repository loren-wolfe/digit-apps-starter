import { useEffect, useRef } from 'react';

/**
 * Re-run `refetch` when the iframe is shown again (tab switch, host navigation back
 * to the app). Skips the initial mount — `useApiQuery` / `useBackendQuery` already
 * fetch then — and coalesces focus + visibility + pageshow that fire together.
 */
export function useRefetchWhenVisible(refetch: () => unknown) {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    const mountedAt = Date.now();
    let last = 0;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - mountedAt < 750) return;
      if (now - last < 1000) return;
      last = now;
      void refetchRef.current();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, []);
}
