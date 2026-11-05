import type { SourceFilterSettings } from './sourceFilter';

export type DigitCarrierOption = { id: string; value: string };

export type SsServiceRow = {
  serviceCode: string;
  name: string;
  inCatalog?: boolean;
  digitOptionId?: string | null;
  digitValue?: string | null;
  matchSource?: string | null;
  inheritedFromCarrier?: boolean;
};

export type SsCarrierRow = {
  carrierCode: string;
  name: string;
  shipstationCarrierId?: string | null;
  inCatalog?: boolean;
  /** Carrier-level Digit default (empty service map). */
  digitOptionId?: string | null;
  digitValue?: string | null;
  matchSource?: string | null;
  services?: SsServiceRow[];
};

export type CarrierMappingRow = {
  ssCarrierCode: string;
  ssServiceCode?: string;
  digitOptionId: string | null;
  source: string;
};

/** Push direction: one Digit shipping carrier and the ShipStation service it resolves to. */
export type DigitCarrierMapRow = {
  digitOptionId: string;
  digitValue: string;
  status: 'missing' | 'unmapped' | 'unconfirmed' | 'ambiguous' | 'ok';
  ssCarrierCode?: string | null;
  ssCarrierName?: string | null;
  ssServiceCode?: string | null;
  ssServiceName?: string | null;
};

export type UnmappedCarrierRow = {
  carrierCode: string | null;
  carrierName: string | null;
  serviceCode?: string | null;
  serviceName?: string | null;
  inCatalog?: boolean;
};

export type OrgSettingsData = {
  organizationId: string;
  defaultFulfillmentMethod: string;
  defaultWeightOz?: number;
  sourceFilter?: SourceFilterSettings;
  digitCarriers?: DigitCarrierOption[];
  digitCarrierMaps?: DigitCarrierMapRow[];
  ssCarriers?: SsCarrierRow[];
  carrierMappings?: CarrierMappingRow[];
  unmappedCarriers?: UnmappedCarrierRow[];
  digitCarriersError?: string | null;
};

export type CarrierDraft = {
  defaults: Record<string, string>;
  services: Record<string, string>;
};

export function serviceDraftKey(carrierCode: string, serviceCode: string) {
  return `${carrierCode}::${serviceCode}`;
}

export function unmatchedServicesFrom(orgSettings: OrgSettingsData | undefined): SsServiceRow[] {
  const out: SsServiceRow[] = [];
  for (const carrier of orgSettings?.ssCarriers ?? []) {
    for (const service of carrier.services ?? []) {
      if (!service.digitOptionId) out.push(service);
    }
  }
  return out;
}

/** Digit carriers that cannot push: no confirmed ShipStation service, or more than one. */
export function pushBlockedDigitCarriersFrom(
  orgSettings: OrgSettingsData | undefined,
): DigitCarrierMapRow[] {
  return (orgSettings?.digitCarrierMaps ?? []).filter((row) => row.status !== 'ok');
}

export function digitCarrierStatusCopy(status: DigitCarrierMapRow['status']) {
  switch (status) {
    case 'ok':
      return { label: 'Ready', color: 'success' as const, hint: 'Push sends this ShipStation service.' };
    case 'unconfirmed':
      return {
        label: 'Confirm',
        color: 'warning' as const,
        hint: 'Auto-matched on name similarity. Pick the service here to allow push.',
      };
    case 'ambiguous':
      return {
        label: 'Ambiguous',
        color: 'error' as const,
        hint: 'Mapped to more than one ShipStation service. Keep it on one.',
      };
    default:
      return {
        label: 'Not mapped',
        color: 'error' as const,
        hint: 'Shipments using this Sutton carrier cannot push to ShipStation.',
      };
  }
}

export function draftFromOrgSettings(orgSettings: OrgSettingsData | undefined): CarrierDraft {
  const defaults: Record<string, string> = {};
  const services: Record<string, string> = {};
  for (const carrier of orgSettings?.ssCarriers ?? []) {
    defaults[carrier.carrierCode] = carrier.digitOptionId || '';
    for (const service of carrier.services ?? []) {
      const pinned = service.matchSource === 'manual' && !service.inheritedFromCarrier;
      services[serviceDraftKey(carrier.carrierCode, service.serviceCode)] = pinned
        ? service.digitOptionId || ''
        : '';
    }
  }
  return { defaults, services };
}

export function mappingsFromDraft(draft: CarrierDraft) {
  const mappings: { ssCarrierCode: string; ssServiceCode: string; digitOptionId: string | null }[] =
    [];
  for (const [ssCarrierCode, digitOptionId] of Object.entries(draft.defaults)) {
    mappings.push({
      ssCarrierCode,
      ssServiceCode: '',
      digitOptionId: digitOptionId ? digitOptionId : null,
    });
  }
  for (const [key, digitOptionId] of Object.entries(draft.services)) {
    const sep = key.indexOf('::');
    const ssCarrierCode = sep === -1 ? key : key.slice(0, sep);
    const ssServiceCode = sep === -1 ? '' : key.slice(sep + 2);
    mappings.push({
      ssCarrierCode,
      ssServiceCode,
      digitOptionId: digitOptionId ? digitOptionId : null,
    });
  }
  return mappings;
}
