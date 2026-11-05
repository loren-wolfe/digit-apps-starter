/** Where a live config value came from, as seen by the worker. */
export type SetupSource = 'appSecret' | 'appDatabase' | null;

export type SetupItem = {
  key: string;
  kind: 'secret' | 'env';
  required: boolean;
  present: boolean;
  valid: boolean;
  source: SetupSource;
  /** The modal does not render this. */
  issue: string | null;
  enables: string;
  description: string;
  /** Profile ids that list this row. Empty means the only checklist. */
  profiles: string[];
  /** Short callout shown with the key, e.g. who has to supply it. */
  note?: string;
  /** Sutton API token permissions the worker needs, with what each is used for. */
  permissions?: { key: string; label: string; use: string }[];
};

export type SetupData = {
  /** Runtime store exists and every required item is present and valid. */
  ready: boolean;
  /** App is published and its runtime store exists. */
  usable: boolean;
  items: SetupItem[];
};
