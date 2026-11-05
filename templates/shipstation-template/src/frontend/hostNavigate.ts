type NavigateOptions = { path: string };

type NavigatingHost = NonNullable<typeof window.DigitHost> & {
  navigate?: (options: NavigateOptions) => void;
};

/**
 * Route navigation on `window.DigitHost`, when the host still provides it. It is not part of the
 * typed host API (`AppHost.invoke('navigate')` only reaches record pages, not shipments), so
 * callers must render a plain label when this returns undefined.
 */
export function hostNavigate(): ((options: NavigateOptions) => void) | undefined {
  return (window.DigitHost as NavigatingHost | undefined)?.navigate;
}
