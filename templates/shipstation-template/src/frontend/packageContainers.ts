export type PackageMeasurement = {
  value?: number | null;
  uom?: { name?: string | null; symbol?: string | null; type?: string | null } | null;
};

export type PackageContainer = {
  id?: string | null;
  container?: string | null;
  packageLength?: PackageMeasurement | null;
  packageWidth?: PackageMeasurement | null;
  packageHeight?: PackageMeasurement | null;
  packageGrossWeight?: PackageMeasurement | null;
  packedItems?: {
    quantity?: number;
    pickedItem?: {
      orderItem?: {
        id?: string;
        customerSku?: string | null;
        item?: { id: string; name?: string | null; sku?: string | null } | null;
      } | null;
    } | null;
  }[] | null;
};

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function formatNumber(value: number) {
  return NUMBER_FORMAT.format(value);
}

function measurementLabel(measurement?: PackageMeasurement | null) {
  const value = Number(measurement?.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = measurement?.uom?.symbol || measurement?.uom?.name;
  return `${formatNumber(value)}${unit ? ` ${unit}` : ''}`;
}

export function packageWeightLabel(container: PackageContainer) {
  return measurementLabel(container.packageGrossWeight);
}

function containerTypeLabel(value?: string | null) {
  if (value === 'asIs') return 'As-is';
  if (value === 'pallet') return 'Pallet';
  return 'Package';
}

function dimensionsLabel(container: PackageContainer) {
  const measurements = [
    container.packageLength,
    container.packageWidth,
    container.packageHeight,
  ];
  const values = measurements.map((measurement) => Number(measurement?.value));
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const units = measurements.map(
    (measurement) => measurement?.uom?.symbol || measurement?.uom?.name || '',
  );
  if (units.every((unit) => unit === units[0])) {
    return `${values.map(formatNumber).join(' × ')}${units[0] ? ` ${units[0]}` : ''}`;
  }
  return measurements.map(measurementLabel).join(' × ');
}

export function packageCountLabel(containers?: PackageContainer[] | null) {
  const count = containers?.length ?? 0;
  return `${count} ${count === 1 ? 'package' : 'packages'}`;
}

export function packageContainerLabel(container: PackageContainer, index: number) {
  const details = [
    containerTypeLabel(container.container),
    measurementLabel(container.packageGrossWeight),
    dimensionsLabel(container),
  ].filter(Boolean);
  return `${index + 1}. ${details.join(' · ')}`;
}
