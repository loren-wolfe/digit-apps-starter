import type { SsServiceResolve } from './eligibility';

export type PackageDimensions = {
  length: number;
  width: number;
  height: number;
  unit: string;
};

export type PackageTypeOption = {
  source: 'custom' | 'carrier';
  packageCode: string;
  packageId?: string | null;
  name: string;
  carrierId?: string | null;
  carrierCode?: string | null;
  dimensions?: PackageDimensions | null;
};

export type CarrierPackageGroup = {
  carrierId?: string | null;
  carrierCode?: string | null;
  packages: PackageTypeOption[];
};

export type PackageCatalog = {
  apiVersion?: string | null;
  customPackages: PackageTypeOption[];
  carrierPackages: CarrierPackageGroup[];
  errors?: { carrierId?: string | null; carrierCode?: string | null; message?: string | null }[];
};

export type PackageSelection = {
  digitShipmentId: string;
  digitContainerId: string;
  source: 'custom' | 'carrier' | 'shipstation';
  packageCode: string;
  packageId?: string | null;
  packageName?: string | null;
  ssCarrierId?: string | null;
  ssCarrierCode?: string | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: string | null;
  weightValue?: number | null;
  weightUnit?: string | null;
  observedFromShipstation?: boolean;
};

export type PackageChoice = {
  source: 'custom' | 'carrier';
  packageCode: string;
  packageId?: string | null;
  packageName: string;
  ssCarrierId?: string | null;
  ssCarrierCode?: string | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimensionUnit?: string | null;
};

type LockableMap = {
  source?: string | null;
  ssShipmentId?: string | null;
  pushStatus?: string | null;
};

export function packageSelectionLocked(map?: LockableMap | null) {
  if (!map) return false;
  if (map.source === 'shipstation') return true;
  if (map.ssShipmentId) return true;
  return ['pushed', 'label_ready', 'shipped'].includes(map.pushStatus || '');
}

export function isStaleCarrierSelection(
  selection: PackageSelection | null | undefined,
  carrier: Pick<SsServiceResolve, 'status' | 'carrierId' | 'carrierCode'> | null | undefined,
) {
  if (!selection || selection.source !== 'carrier') return false;
  if (!carrier || carrier.status !== 'ok') return false;
  const savedId = String(selection.ssCarrierId || '').trim();
  const savedCode = String(selection.ssCarrierCode || '').trim();
  const nextId = String(carrier.carrierId || '').trim();
  const nextCode = String(carrier.carrierCode || '').trim();
  if (savedId && nextId) return savedId !== nextId;
  if (savedCode && nextCode) return savedCode !== nextCode;
  return false;
}

export function missingPackageTypeReason(selection: { packageName?: string | null; packageCode?: string | null }) {
  const name = String(selection.packageName || selection.packageCode || '').trim();
  const label = name || 'The selected package type';
  return `${label} is no longer available in ShipStation. Pick another package type or use Sutton dimensions, then try again.`;
}

export function isMissingPackageSelection(
  selection: PackageSelection | null | undefined,
  { customPackages, carrierPackages, carrierReady }: {
    customPackages: PackageTypeOption[];
    carrierPackages: PackageTypeOption[];
    carrierReady: boolean;
  },
) {
  if (!selection || selection.observedFromShipstation || selection.source === 'shipstation') return false;
  if (selection.source === 'carrier' && !carrierReady) return false;
  const list = selection.source === 'custom' ? customPackages : carrierPackages;
  return !list.some((pkg) => pkg.packageCode === selection.packageCode);
}

export function selectionOptionValue(selection: { source: string; packageCode: string }) {
  return `${selection.source}:${selection.packageCode}`;
}

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatPackageDimensions(
  length?: number | null,
  width?: number | null,
  height?: number | null,
  unit?: string | null,
) {
  const values = [length, width, height].map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const label = unit === 'centimeter' ? 'cm' : unit === 'inch' || !unit ? 'in' : unit;
  return `${values.map((value) => NUMBER_FORMAT.format(value)).join(' × ')} ${label}`;
}

export function formatPackageWeight(value?: number | null, unit?: string | null) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const label =
    unit === 'pound' ? 'lb' : unit === 'ounce' ? 'oz' : unit === 'gram' ? 'g' : unit === 'kilogram' ? 'kg' : unit || '';
  return `${NUMBER_FORMAT.format(number)}${label ? ` ${label}` : ''}`;
}
