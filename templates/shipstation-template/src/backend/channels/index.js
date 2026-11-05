/**
 * Post-writeback channel adapters. Default is a no-op for Shopify/WooCommerce when
 * Digit Rutter pushFulfillments covers the store. Enable direct adapters via app secrets.
 */

export {
  afterDigitShipped,
  runAfterDigitShipped,
  listAdapters,
  getAdapter,
  channelSetupEntries,
  channelStatusForOrg,
} from './registry.js';
