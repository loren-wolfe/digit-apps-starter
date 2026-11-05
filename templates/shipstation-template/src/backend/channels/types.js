/**
 * @typedef {'success' | 'skipped' | 'error'} ChannelResultStatus
 */

/**
 * @typedef {object} ChannelResult
 * @property {ChannelResultStatus} status
 * @property {boolean} [skipped]
 * @property {string} [reason]
 * @property {string} [message]
 * @property {string} [externalOrderId]
 */

/**
 * @typedef {object} ChannelAdapterContext
 * @property {Record<string, unknown>} env
 * @property {import('@cloudflare/workers-types').D1Database | null} db
 * @property {string | null} [organizationId]
 */

/**
 * @typedef {object} AfterDigitShippedContext
 * @property {Record<string, unknown>} env
 * @property {import('@cloudflare/workers-types').D1Database | null} db
 * @property {string | null} [organizationId]
 * @property {Record<string, unknown>} order
 * @property {{ trackingNumber?: string | null, carrierName?: string | null, shipDate?: string | null, digitShipmentId?: string | null }} shipment
 */

/**
 * @typedef {object} ChannelAdapter
 * @property {string} id
 * @property {string} label
 * @property {string[]} secretKeys
 * @property {(ctx: ChannelAdapterContext) => Promise<boolean>} isConfigured
 * @property {(ctx: AfterDigitShippedContext) => Promise<ChannelResult>} [afterDigitShipped]
 */

export {};
