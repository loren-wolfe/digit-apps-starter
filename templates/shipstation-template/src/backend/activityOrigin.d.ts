export type ActivityOrigin = 'sutton' | 'shipstation' | 'channel' | 'app' | 'unknown';

export function inferActivityOrigin(event?: {
  actor?: string | null;
  action?: string | null;
  status?: string | null;
  message?: string | null;
  detail?: unknown;
}): ActivityOrigin;
