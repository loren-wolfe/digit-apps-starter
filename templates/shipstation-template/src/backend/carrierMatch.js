/**
 * Pure ShipStation ↔ Digit shipping-carrier matching (no Worker I/O).
 * Auto-match uses service name/code, never brand-only (stamps_com → USPS).
 */

const FUZZY_MIN = 0.85;
const FUZZY_GAP = 0.15;

/** Normalized key → canonical brand used to gate service matches. */
const ALIASES = {
  stampscom: 'usps',
  stampsendicia: 'usps',
  endicia: 'usps',
  usps: 'usps',
  pitneybowes: 'usps',
  stamps: 'usps',
  ups: 'ups',
  upswalleted: 'ups',
  fedex: 'fedex',
  fedexwalleted: 'fedex',
  dhl: 'dhl',
  dhlexpress: 'dhl',
  dhlexpressworldwide: 'dhl',
  amazon: 'amazon',
  amazonshipping: 'amazon',
};

export function normalizeCarrierKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function canonicalCarrierKey(value) {
  const key = normalizeCarrierKey(value);
  return ALIASES[key] || key;
}

export function mappingKey(ssCarrierCode, ssServiceCode = '') {
  return `${String(ssCarrierCode || '').trim()}\0${String(ssServiceCode || '').trim()}`;
}

function tokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => ALIASES[part] || part)
    .filter((part) => part.length >= 2);
}

function bigrams(value) {
  const s = String(value || '');
  if (s.length < 2) return s ? [s] : [];
  const grams = [];
  for (let i = 0; i < s.length - 1; i += 1) grams.push(s.slice(i, i + 2));
  return grams;
}

function diceCoefficient(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map();
  for (const gram of left) counts.set(gram, (counts.get(gram) || 0) + 1);
  let overlap = 0;
  for (const gram of right) {
    const n = counts.get(gram) || 0;
    if (n > 0) {
      overlap += 1;
      counts.set(gram, n - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
}

function tokenOverlap(ssTokens, digitTokens) {
  if (digitTokens.length === 0 || ssTokens.length === 0) return 0;
  const ss = new Set(ssTokens);
  const hits = digitTokens.filter((token) => ss.has(token)).length;
  return hits / Math.max(digitTokens.length, 1);
}

export function liveOptions(options) {
  return (options ?? []).filter((option) => option && option.id && option.value && !option.deleted);
}

export function isBrandOnlyOption(optionValue, brandCanon) {
  if (!brandCanon) return false;
  const remaining = tokens(optionValue).filter((token) => canonicalCarrierKey(token) !== brandCanon);
  return remaining.length === 0;
}

function optionMatchesBrand(optionValue, brandCanon) {
  if (!brandCanon) return true;
  const optCanon = canonicalCarrierKey(optionValue);
  const optTokens = tokens(optionValue).map(canonicalCarrierKey);
  return optCanon === brandCanon || optTokens.includes(brandCanon);
}

function fromPersistedMap(mapping, options) {
  const list = liveOptions(options);
  const optionById = new Map(list.map((option) => [option.id, option]));
  if (!mapping?.digitOptionId || !optionById.has(mapping.digitOptionId)) return null;
  if (mapping.source !== 'manual' && mapping.source !== 'fuzzy') return null;
  const option = optionById.get(mapping.digitOptionId);
  return {
    digitOptionId: option.id,
    digitValue: option.value,
    matchSource: mapping.source,
    inheritedFromCarrier: false,
  };
}

/**
 * Effective Digit match for a ShipStation carrier + service.
 * Precedence: service map, then carrier default, then service-string auto-match.
 */
export function effectiveCarrierMatch({
  carrierCode,
  carrierName,
  serviceCode,
  serviceName,
  options,
  serviceMapping,
  carrierMapping,
  mapping,
}) {
  const list = liveOptions(options);
  const serviceHit = fromPersistedMap(serviceMapping, list);
  if (serviceHit) return serviceHit;

  // Back-compat: callers that still pass a single `mapping` treat it as a service map.
  if (!serviceMapping && mapping) {
    const legacy = fromPersistedMap(mapping, list);
    if (legacy) return legacy;
  }

  const carrierHit = fromPersistedMap(carrierMapping, list);
  if (carrierHit) {
    return { ...carrierHit, matchSource: 'carrier', inheritedFromCarrier: true };
  }

  const matched = matchDigitCarrierOptions({
    carrierCode,
    carrierName,
    serviceCode,
    serviceName,
    options: list,
  });
  if (matched) {
    return {
      digitOptionId: matched.option.id,
      digitValue: matched.option.value,
      matchSource: matched.method,
      inheritedFromCarrier: false,
    };
  }
  return {
    digitOptionId: null,
    digitValue: null,
    matchSource: null,
    inheritedFromCarrier: false,
  };
}

export function findSsCatalogRow({ ssCarriers, value }) {
  const key = String(value || '').trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  return (
    (ssCarriers ?? []).find((row) => String(row.carrierCode || '') === key) ||
    (ssCarriers ?? []).find((row) => String(row.shipstationCarrierId || '') === key) ||
    (ssCarriers ?? []).find((row) => String(row.name || '').toLowerCase() === lower) ||
    null
  );
}

/**
 * Reverse-map a Digit shippingCarriers option onto a unique ShipStation carrier + service.
 * Only confirmed (`manual`) service-level maps count. Carrier defaults and auto-matched
 * (`fuzzy`) rows are never enough to push: a human has to confirm the service.
 *
 * @returns {{
 *   status: 'missing' | 'unmapped' | 'unconfirmed' | 'ambiguous' | 'ok',
 *   carrierId: string | null,
 *   carrierCode: string | null,
 *   serviceCode: string | null,
 *   serviceName: string | null,
 *   digitOptionId: string | null,
 *   digitValue: string | null,
 * }}
 */
export function resolveSsServiceFromDigitOption({
  digitOptionId,
  digitValue = null,
  mappings = [],
  ssCarriers = [],
}) {
  const optionId = digitOptionId != null ? String(digitOptionId).trim() : '';
  const blank = (status) => ({
    status,
    carrierId: null,
    carrierCode: null,
    serviceCode: null,
    serviceName: null,
    digitOptionId: optionId || null,
    digitValue: digitValue ? String(digitValue) : null,
  });
  if (!optionId) return blank('missing');

  const hits = [];
  for (const row of mappings ?? []) {
    if (!row?.digitOptionId || String(row.digitOptionId) !== optionId) continue;
    const serviceCode = String(row.ssServiceCode ?? '').trim();
    if (!serviceCode) continue;
    const carrierCode = String(row.ssCarrierCode || '').trim();
    if (!carrierCode) continue;
    hits.push({ carrierCode, serviceCode, source: row.source || null });
  }

  if (hits.length === 0) return blank('unmapped');

  const confirmed = hits.filter((hit) => hit.source === 'manual');
  if (confirmed.length === 0) return blank('unconfirmed');

  const uniqueKeys = new Set(confirmed.map((hit) => mappingKey(hit.carrierCode, hit.serviceCode)));
  if (uniqueKeys.size > 1) return blank('ambiguous');

  const hit = confirmed[0];
  const catalog = findSsCatalogRow({ ssCarriers, value: hit.carrierCode });
  const service = (catalog?.services ?? []).find(
    (row) => String(row.serviceCode || '').trim() === hit.serviceCode,
  );
  return {
    status: 'ok',
    carrierId: catalog?.shipstationCarrierId
      ? String(catalog.shipstationCarrierId)
      : null,
    carrierCode: catalog?.carrierCode || hit.carrierCode,
    serviceCode: hit.serviceCode,
    serviceName: service?.name || hit.serviceCode,
    digitOptionId: optionId,
    digitValue: digitValue ? String(digitValue) : null,
  };
}

function indexMappings(mappings) {
  const byKey = new Map();
  for (const row of mappings ?? []) {
    if (!row?.ssCarrierCode) continue;
    byKey.set(mappingKey(row.ssCarrierCode, row.ssServiceCode), row);
  }
  return byKey;
}

function emptyMatch() {
  return {
    digitOptionId: null,
    digitValue: null,
    matchSource: null,
    inheritedFromCarrier: false,
  };
}

function annotateService({
  carrierCode,
  carrierName,
  serviceCode,
  serviceName,
  inCatalog,
  options,
  mappings,
}) {
  const match = effectiveCarrierMatch({
    carrierCode,
    carrierName,
    serviceCode,
    serviceName,
    options,
    serviceMapping: mappings.get(mappingKey(carrierCode, serviceCode)),
    carrierMapping: mappings.get(mappingKey(carrierCode, '')),
  });
  return {
    serviceCode: serviceCode || '',
    name: serviceName || serviceCode || 'Unknown service',
    inCatalog: Boolean(inCatalog),
    digitOptionId: match.digitOptionId,
    digitValue: match.digitValue,
    matchSource: match.matchSource,
    inheritedFromCarrier: Boolean(match.inheritedFromCarrier),
  };
}

/**
 * Build the carrier-modal payload without I/O.
 * `pulledServices` are distinct { carrierCode, serviceCode, serviceName } from order maps.
 */
export function buildCarrierMapPayload({
  digitCarriers,
  ssCarriers,
  mappings,
  pulledCarrierNames,
  pulledServices,
  digitCarriersError = null,
}) {
  const options = liveOptions(digitCarriers);
  const mappingByKey = indexMappings(mappings);
  const catalog = [];
  const seenCarriers = new Set();

  for (const row of ssCarriers ?? []) {
    const carrierCode = String(row.carrierCode || row.shipstationCarrierId || '').trim();
    if (!carrierCode || seenCarriers.has(carrierCode)) continue;
    seenCarriers.add(carrierCode);
    const carrierMapping = mappingByKey.get(mappingKey(carrierCode, ''));
    const carrierDefault = fromPersistedMap(carrierMapping, options) || emptyMatch();
    const services = [];
    const seenServices = new Set();
    for (const service of row.services ?? []) {
      const serviceCode = String(service.serviceCode || '').trim();
      if (!serviceCode || seenServices.has(serviceCode)) continue;
      seenServices.add(serviceCode);
      services.push(
        annotateService({
          carrierCode,
          carrierName: row.name,
          serviceCode,
          serviceName: service.name,
          inCatalog: true,
          options,
          mappings: mappingByKey,
        }),
      );
    }
    catalog.push({
      carrierCode,
      name: row.name || carrierCode,
      shipstationCarrierId: row.shipstationCarrierId || null,
      inCatalog: true,
      digitOptionId: carrierDefault.digitOptionId,
      digitValue: carrierDefault.digitValue,
      matchSource: carrierDefault.matchSource,
      services,
      _seenServices: seenServices,
    });
  }

  const pulled = [];
  if (Array.isArray(pulledServices) && pulledServices.length > 0) {
    pulled.push(...pulledServices);
  } else {
    for (const name of pulledCarrierNames ?? []) {
      pulled.push({ carrierCode: name, serviceCode: '', serviceName: null });
    }
  }

  const seenPulled = new Set();
  const unmapped = [];
  for (const item of pulled) {
    const rawCarrier = String(item.carrierCode || item.carrierName || '').trim();
    const serviceCode = String(item.serviceCode || '').trim();
    if (!rawCarrier && !serviceCode) continue;
    const seenKey = `${rawCarrier.toLowerCase()}\0${serviceCode.toLowerCase()}`;
    if (seenPulled.has(seenKey)) continue;
    seenPulled.add(seenKey);

    const found =
      findSsCatalogRow({ ssCarriers: catalog, value: rawCarrier }) ||
      findSsCatalogRow({ ssCarriers: ssCarriers ?? [], value: rawCarrier });
    const carrierCode = found?.carrierCode || rawCarrier;
    const carrierName = found?.name || item.carrierName || rawCarrier;
    if (!found && carrierCode && !seenCarriers.has(carrierCode)) {
      seenCarriers.add(carrierCode);
      const carrierDefault =
        fromPersistedMap(mappingByKey.get(mappingKey(carrierCode, '')), options) || emptyMatch();
      catalog.push({
        carrierCode,
        name: carrierName,
        shipstationCarrierId: null,
        inCatalog: false,
        digitOptionId: carrierDefault.digitOptionId,
        digitValue: carrierDefault.digitValue,
        matchSource: carrierDefault.matchSource,
        services: [],
        _seenServices: new Set(),
      });
    }
    const group = catalog.find((row) => row.carrierCode === carrierCode);
    if (!group) continue;
    if (serviceCode && group._seenServices.has(serviceCode)) continue;
    if (serviceCode) group._seenServices.add(serviceCode);
    const annotated = annotateService({
      carrierCode,
      carrierName: group.name,
      serviceCode,
      serviceName: item.serviceName,
      inCatalog: false,
      options,
      mappings: mappingByKey,
    });
    if (serviceCode || !group.services.some((row) => !row.serviceCode)) {
      group.services.push(annotated);
    }
  }

  for (const group of catalog) {
    for (const service of group.services) {
      if (service.digitOptionId) continue;
      unmapped.push({
        carrierCode: group.carrierCode,
        carrierName: group.name,
        serviceCode: service.serviceCode || null,
        serviceName: service.name || null,
        inCatalog: Boolean(service.inCatalog && group.inCatalog),
      });
    }
  }

  // Push direction: every Digit option needs one confirmed ShipStation service.
  const digitCarrierMaps = options.map((option) => {
    const resolved = resolveSsServiceFromDigitOption({
      digitOptionId: option.id,
      digitValue: option.value,
      mappings,
      ssCarriers: catalog,
    });
    const carrier = resolved.carrierCode
      ? findSsCatalogRow({ ssCarriers: catalog, value: resolved.carrierCode })
      : null;
    return {
      digitOptionId: option.id,
      digitValue: option.value,
      status: resolved.status,
      ssCarrierCode: resolved.carrierCode,
      ssCarrierName: carrier?.name || resolved.carrierCode,
      ssServiceCode: resolved.serviceCode,
      ssServiceName: resolved.serviceName,
    };
  });

  return {
    digitCarriers: options.map((option) => ({ id: option.id, value: option.value })),
    digitCarrierMaps,
    ssCarriers: catalog.map((row) => ({
      carrierCode: row.carrierCode,
      name: row.name,
      shipstationCarrierId: row.shipstationCarrierId || null,
      inCatalog: row.inCatalog,
      digitOptionId: row.digitOptionId,
      digitValue: row.digitValue,
      matchSource: row.matchSource,
      services: row.services,
    })),
    carrierMappings: (mappings ?? []).map((row) => ({
      ssCarrierCode: row.ssCarrierCode,
      ssServiceCode: String(row.ssServiceCode ?? ''),
      digitOptionId: row.digitOptionId,
      source: row.source,
    })),
    unmappedCarriers: unmapped,
    digitCarriersError,
  };
}

/**
 * Auto-match a ShipStation *service* onto a Digit shippingCarriers option.
 * Brand-only Digit options (just "UPS") never auto-match a service.
 * @returns {{ option: { id: string, value: string }, method: 'exact' | 'alias' | 'fuzzy' } | null}
 */
export function matchDigitCarrierOptions({
  carrierCode,
  carrierName,
  serviceCode,
  serviceName,
  options,
}) {
  const list = liveOptions(options);
  if (list.length === 0) return null;

  const serviceCandidates = [serviceName, serviceCode].filter(Boolean);
  if (serviceCandidates.length === 0) return null;

  const brandCanon =
    canonicalCarrierKey(carrierName) || canonicalCarrierKey(carrierCode) || null;
  const pool = list.filter((option) => optionMatchesBrand(option.value, brandCanon));
  if (pool.length === 0) return null;

  const ssKeys = serviceCandidates.map(normalizeCarrierKey).filter(Boolean);

  for (const option of pool) {
    const key = normalizeCarrierKey(option.value);
    if (ssKeys.includes(key)) {
      return { option, method: 'exact' };
    }
  }

  const scored = pool
    .filter((option) => !isBrandOnlyOption(option.value, brandCanon))
    .map((option) => {
      const optKey = normalizeCarrierKey(option.value);
      const nameDice = Math.max(...ssKeys.map((key) => diceCoefficient(key, optKey)), 0);
      const overlap = tokenOverlap(
        [...tokens(serviceName), ...tokens(serviceCode)],
        tokens(option.value),
      );
      return { option, score: Math.max(nameDice, overlap) };
    });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < FUZZY_MIN) return null;
  if (second && best.score - second.score < FUZZY_GAP) return null;
  return { option: best.option, method: 'fuzzy' };
}
