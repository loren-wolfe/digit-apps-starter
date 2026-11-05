const DEFAULT_WEIGHT_OZ = 16;

const MASS_TO_OUNCES = new Map([
  ['oz', 1],
  ['ounce', 1],
  ['ounces', 1],
  ['lb', 16],
  ['lbs', 16],
  ['pound', 16],
  ['pounds', 16],
  ['g', 0.0352739619],
  ['gram', 0.0352739619],
  ['grams', 0.0352739619],
  ['kg', 35.2739619],
  ['kilogram', 35.2739619],
  ['kilograms', 35.2739619],
]);

const LENGTH_TO_INCHES = new Map([
  ['in', 1],
  ['inch', 1],
  ['inches', 1],
  ['ft', 12],
  ['foot', 12],
  ['feet', 12],
  ['yd', 36],
  ['yard', 36],
  ['yards', 36],
  ['mm', 0.0393700787],
  ['millimeter', 0.0393700787],
  ['millimeters', 0.0393700787],
  ['cm', 0.3937007874],
  ['centimeter', 0.3937007874],
  ['centimeters', 0.3937007874],
  ['m', 39.37007874],
  ['meter', 39.37007874],
  ['meters', 39.37007874],
]);

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function unitTokens(measurement) {
  return [measurement?.uom?.symbol, measurement?.uom?.name]
    .map((value) => String(value ?? '').trim().toLowerCase().replace(/\./g, ''))
    .filter(Boolean);
}

function convertMeasurement(measurement, factors) {
  const value = positiveNumber(measurement?.value);
  if (value == null) return null;
  for (const token of unitTokens(measurement)) {
    const factor = factors.get(token);
    if (factor) return Number((value * factor).toFixed(6));
  }
  return null;
}

export function measurementToOunces(measurement) {
  return convertMeasurement(measurement, MASS_TO_OUNCES);
}

export function measurementToInches(measurement) {
  return convertMeasurement(measurement, LENGTH_TO_INCHES);
}

function dimensionsFromOrgSettings(orgSettings) {
  const length = positiveNumber(orgSettings?.defaultLengthIn);
  const width = positiveNumber(orgSettings?.defaultWidthIn);
  const height = positiveNumber(orgSettings?.defaultHeightIn);
  return length != null && width != null && height != null
    ? { length, width, height, unit: 'inch' }
    : null;
}

function dimensionsFromContainer(container) {
  const length = measurementToInches(container?.packageLength);
  const width = measurementToInches(container?.packageWidth);
  const height = measurementToInches(container?.packageHeight);
  return length != null && width != null && height != null
    ? { length, width, height, unit: 'inch' }
    : null;
}

const PACKAGE_ID_PATTERN = /^se(-[a-z0-9]+)+$/;

function dimensionsFromSelection(selection) {
  const length = positiveNumber(selection?.dimensions?.length);
  const width = positiveNumber(selection?.dimensions?.width);
  const height = positiveNumber(selection?.dimensions?.height);
  if (length == null || width == null || height == null) return null;
  const unit = selection.dimensions.unit === 'centimeter' ? 'centimeter' : 'inch';
  return { length, width, height, unit };
}

function selectionForContainer(selectionsByContainerId, container) {
  if (!selectionsByContainerId) return null;
  const id = String(container?.id ?? '').trim();
  if (!id) return null;
  if (typeof selectionsByContainerId.get === 'function') {
    return selectionsByContainerId.get(id) ?? null;
  }
  return selectionsByContainerId[id] ?? null;
}

export function packageFromOrgSettings(orgSettings) {
  const weightOz = positiveNumber(orgSettings?.defaultWeightOz) ?? DEFAULT_WEIGHT_OZ;
  const pkg = {
    package_code: 'package',
    weight: { value: weightOz, unit: 'ounce' },
  };
  const dimensions = dimensionsFromOrgSettings(orgSettings);
  if (dimensions) pkg.dimensions = dimensions;
  return pkg;
}

export function packageFromDigitContainer(container, orgSettings, selection = null) {
  const fallback = packageFromOrgSettings(orgSettings);
  const packageId = String(container?.id ?? '').trim();
  const chosenCode = String(selection?.packageCode || '').trim();
  const pkg = {
    package_code: chosenCode || 'package',
    weight: {
      value: measurementToOunces(container?.packageGrossWeight) ?? fallback.weight.value,
      unit: 'ounce',
    },
  };
  if (packageId) pkg.external_package_id = packageId;
  if (chosenCode) {
    const ssPackageId = String(selection?.packageId || '').trim();
    if (PACKAGE_ID_PATTERN.test(ssPackageId)) pkg.package_id = ssPackageId;
    // A chosen type with no catalog dimensions (flat-rate) must not send Sutton dimensions.
    const dimensions = dimensionsFromSelection(selection);
    if (dimensions) pkg.dimensions = dimensions;
    return pkg;
  }
  const dimensions = dimensionsFromContainer(container) ?? fallback.dimensions;
  if (dimensions) pkg.dimensions = dimensions;
  return pkg;
}

export function packagesFromDigitShipment(shipment, orgSettings, selectionsByContainerId = null) {
  const containers = shipment?.packContainers ?? [];
  return containers.length > 0
    ? containers.map((container) =>
        packageFromDigitContainer(
          container,
          orgSettings,
          selectionForContainer(selectionsByContainerId, container),
        ),
      )
    : [packageFromOrgSettings(orgSettings)];
}

export function v1PackageFieldsFromDigitContainer(container, orgSettings, selection = null) {
  const pkg = packageFromDigitContainer(container, orgSettings, selection);
  const units = pkg.dimensions?.unit === 'centimeter' ? 'centimeters' : 'inches';
  return {
    packageCode: pkg.package_code,
    weight: { value: pkg.weight.value, units: 'ounces' },
    ...(pkg.dimensions
      ? {
          dimensions: {
            length: pkg.dimensions.length,
            width: pkg.dimensions.width,
            height: pkg.dimensions.height,
            units,
          },
        }
      : {}),
  };
}
