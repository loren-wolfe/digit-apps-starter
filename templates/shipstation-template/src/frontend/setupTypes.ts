/** Where a live config value came from, as seen by the Worker. */
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
};

export type ChannelSecretStatus = {
  key: string;
  present: boolean;
  source: SetupSource;
};

export type ChannelSetupEntry = {
  id: string;
  label: string;
  configured: boolean;
  secrets: ChannelSecretStatus[];
};

export type SetupData = {
  /** Every required value is live in the Worker. */
  ready: boolean;
  /** The publish binding exists, so the app can run at all. */
  usable: boolean;
  apiTokenPresent: boolean;
  shipStationKeyPresent: boolean;
  shipStationSecretPresent: boolean;
  shipStationApiMode: 'v1' | 'v2' | 'missing';
  anyChannelConfigured: boolean;
  items: SetupItem[];
  channels: ChannelSetupEntry[];
};
