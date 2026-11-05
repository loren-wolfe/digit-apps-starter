/** Where a live config value came from, as seen by the worker. */
export type SetupSource = 'appSecret' | 'appDatabase' | null;

export type SetupItem = {
  key: string;
  kind: 'secret' | 'env';
  required: boolean;
  present: boolean;
  valid: boolean;
  source: SetupSource;
  issue: string | null;
  enables: string;
  description: string;
  profiles: string[];
};

export type SetupStore = {
  id: string;
  label: string;
  shop: string | null;
  domain: string | null;
  configured: boolean;
  ready: boolean;
  error: string | null;
  name: string | null;
};

export type SetupData = {
  ready: boolean;
  usable: boolean;
  items: SetupItem[];
  stores: SetupStore[];
};
