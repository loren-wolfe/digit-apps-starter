const LABELS: Record<string, string> = {
  API_TOKEN_SUTTON: 'Sutton API token',
  WC_STORE_URL: 'WooCommerce store URL',
  WC_CONSUMER_KEY: 'WooCommerce consumer key',
  WC_CONSUMER_SECRET: 'WooCommerce consumer secret',
  FULFILLMENT_LOG_SINCE: 'Log start date',
};

export function secretLabel(key: string) {
  return LABELS[key] || key;
}
