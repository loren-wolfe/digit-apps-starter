import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { effectiveShippingCarrierField, resolveSsServiceFromDigitOption, type CarrierMapsForEligibility } from '../eligibility';
import { packageContainerLabel, packageCountLabel, packageWeightLabel, type PackageContainer } from '../packageContainers';
import {
  formatPackageDimensions,
  formatPackageWeight,
  isMissingPackageSelection,
  missingPackageTypeReason,
  selectionOptionValue,
  type PackageCatalog,
  type PackageChoice,
  type PackageSelection,
  type PackageTypeOption,
} from '../packageSelection';

type ShipmentPackages = {
  id: string;
  packContainers?: PackageContainer[] | null;
  shippingCarrierField?: { id?: string | null; value?: string | null } | null;
  order?: { shippingCarrierField?: { id?: string | null; value?: string | null } | null } | null;
};

function carrierPackagesFor(
  catalog: PackageCatalog | null | undefined,
  carrierId: string | null,
  carrierCode: string | null,
) {
  const groups = catalog?.carrierPackages ?? [];
  const group = groups.find(
    (entry) =>
      (carrierId && entry.carrierId === carrierId) || (carrierCode && entry.carrierCode === carrierCode),
  );
  return group?.packages ?? [];
}

function choiceFromOption(
  option: PackageTypeOption,
  carrier: { carrierId: string | null; carrierCode: string | null },
): PackageChoice {
  return {
    source: option.source,
    packageCode: option.packageCode,
    packageId: option.packageId ?? null,
    packageName: option.name,
    ssCarrierId: option.source === 'carrier' ? carrier.carrierId : null,
    ssCarrierCode: option.source === 'carrier' ? carrier.carrierCode : null,
    length: option.dimensions?.length ?? null,
    width: option.dimensions?.width ?? null,
    height: option.dimensions?.height ?? null,
    dimensionUnit: option.dimensions?.unit ?? null,
  };
}

function selectedLine(selection: PackageSelection, container: PackageContainer, index: number) {
  const name =
    selection.packageName || (selection.packageCode === 'package' ? 'Package' : selection.packageCode);
  const dimensions = formatPackageDimensions(
    selection.length,
    selection.width,
    selection.height,
    selection.dimensionUnit,
  );
  const weight = selection.observedFromShipstation
    ? formatPackageWeight(selection.weightValue, selection.weightUnit) || packageWeightLabel(container)
    : packageWeightLabel(container);
  return `${index + 1}. ${[name, weight, dimensions].filter(Boolean).join(' · ')}`;
}

function optionItems(options: PackageTypeOption[]) {
  return options.map((option) => (
    <MenuItem key={`${option.source}:${option.packageCode}`} value={selectionOptionValue(option)}>
      {option.name}
    </MenuItem>
  ));
}

function loadingPackageItem(value: string) {
  return (
    <MenuItem disabled value={value}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <CircularProgress size={14} />
        <span>Loading package types…</span>
      </Stack>
    </MenuItem>
  );
}

export default function PackageTypeList({
  shipment,
  selections,
  orgSettings,
  apiVersion,
  catalog,
  catalogLoaded,
  catalogLoading = false,
  locked,
  savingContainerId,
  onChange,
}: {
  shipment: ShipmentPackages;
  selections: PackageSelection[];
  orgSettings?: CarrierMapsForEligibility | null;
  apiVersion?: string | null;
  catalog?: PackageCatalog | null;
  catalogLoaded: boolean;
  catalogLoading?: boolean;
  locked: boolean;
  savingContainerId?: string | null;
  onChange: (containerId: string, choice: PackageChoice | null) => void;
}) {
  const containers = shipment.packContainers ?? [];
  const field = effectiveShippingCarrierField(shipment);
  const resolved = resolveSsServiceFromDigitOption({
    digitOptionId: field?.id,
    digitValue: field?.value,
    mappings: orgSettings?.carrierMappings ?? orgSettings?.mappings ?? [],
    ssCarriers: orgSettings?.ssCarriers ?? [],
  });
  const carrierReady = resolved.status === 'ok';
  const carrierName =
    orgSettings?.ssCarriers?.find(
      (carrier) =>
        (resolved.carrierId && carrier.shipstationCarrierId === resolved.carrierId) ||
        (resolved.carrierCode && carrier.carrierCode === resolved.carrierCode),
    )?.name || null;
  const customPackages = apiVersion === 'v1' ? [] : (catalog?.customPackages ?? []);
  const carrierPackages = carrierReady
    ? carrierPackagesFor(catalog, resolved.carrierId, resolved.carrierCode)
    : [];
  const knownValues = new Set([
    ...customPackages.map(selectionOptionValue),
    ...carrierPackages.map(selectionOptionValue),
  ]);

  return (
    <Stack spacing={0.75}>
      <Typography variant="body2">{packageCountLabel(containers)}</Typography>
      {containers.map((container, index) => {
        const selection = selections.find((row) => row.digitContainerId === container.id) ?? null;
        const missing =
          catalogLoaded &&
          !locked &&
          isMissingPackageSelection(selection, { customPackages, carrierPackages, carrierReady });
        const value = selection ? selectionOptionValue(selection) : '';
        const saving = Boolean(container.id && savingContainerId === container.id);
        return (
          <Stack key={container.id || index} spacing={0.25}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {selection ? selectedLine(selection, container, index) : packageContainerLabel(container, index)}
            </Typography>
            {container.id ? (
              <FormControl size="small" fullWidth disabled={locked || saving}>
                <Select
                  value={value}
                  displayEmpty
                  disabled={locked || saving}
                  inputProps={{ 'aria-label': `Package type for package ${index + 1}` }}
                  onChange={(event) => {
                    const next = String(event.target.value || '');
                    if (!next) {
                      onChange(container.id as string, null);
                      return;
                    }
                    const option = [...customPackages, ...carrierPackages].find(
                      (pkg) => selectionOptionValue(pkg) === next,
                    );
                    if (!option) return;
                    onChange(
                      container.id as string,
                      choiceFromOption(option, {
                        carrierId: resolved.carrierId,
                        carrierCode: resolved.carrierCode,
                      }),
                    );
                  }}
                  renderValue={(selected) => {
                    if (!selected && catalogLoading) {
                      return (
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <CircularProgress size={14} />
                          <span>Loading package types…</span>
                        </Stack>
                      );
                    }
                    if (!selected) return 'Sutton dimensions';
                    return selection?.packageName || selection?.packageCode || 'Package type';
                  }}
                >
                  <MenuItem value="">Sutton dimensions</MenuItem>
                  {apiVersion === 'v1' ? null : (
                    <ListSubheader>Custom</ListSubheader>
                  )}
                  {apiVersion === 'v1' ? null : customPackages.length > 0 ? (
                    optionItems(customPackages)
                  ) : catalogLoading ? (
                    loadingPackageItem('__loading_custom')
                  ) : (
                    <MenuItem disabled value="__no_custom">
                      No custom packages
                    </MenuItem>
                  )}
                  {carrierReady ? <ListSubheader>{carrierName || 'Carrier packages'}</ListSubheader> : null}
                  {carrierReady && carrierPackages.length === 0
                    ? catalogLoading
                      ? loadingPackageItem('__loading_carrier')
                      : (
                        <MenuItem disabled value="__no_carrier">
                          No carrier packages
                        </MenuItem>
                      )
                    : null}
                  {carrierReady ? optionItems(carrierPackages) : null}
                  {selection && !knownValues.has(value) ? (
                    <MenuItem value={value}>{selection.packageName || selection.packageCode}</MenuItem>
                  ) : null}
                </Select>
              </FormControl>
            ) : null}
            {missing && selection ? (
              <Typography variant="caption" color="error">
                {missingPackageTypeReason(selection)}
              </Typography>
            ) : null}
          </Stack>
        );
      })}
      {apiVersion === 'v1' ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Carrier packages only. Packages saved on the ShipStation account need a V2 connection.
        </Typography>
      ) : null}
      {apiVersion !== 'v1' && !carrierReady ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Carrier packages appear after this shipment&apos;s Sutton carrier is mapped.
        </Typography>
      ) : null}
      {locked ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Already in ShipStation. Change the package there, then pull to refresh this queue.
        </Typography>
      ) : null}
    </Stack>
  );
}

export function missingSelectionReason({
  containers,
  selections,
  catalog,
  catalogLoaded,
  locked,
  apiVersion,
  carrierReady,
  carrierId,
  carrierCode,
}: {
  containers?: PackageContainer[] | null;
  selections: PackageSelection[];
  catalog?: PackageCatalog | null;
  catalogLoaded: boolean;
  locked: boolean;
  apiVersion?: string | null;
  carrierReady: boolean;
  carrierId?: string | null;
  carrierCode?: string | null;
}) {
  if (!catalogLoaded || locked) return null;
  const customPackages = apiVersion === 'v1' ? [] : (catalog?.customPackages ?? []);
  const carrierPackages = carrierReady
    ? (catalog?.carrierPackages ?? []).find(
        (entry) =>
          (carrierId && entry.carrierId === carrierId) || (carrierCode && entry.carrierCode === carrierCode),
      )?.packages ?? []
    : [];
  for (const container of containers ?? []) {
    const selection = selections.find((row) => row.digitContainerId === container.id);
    if (
      selection &&
      isMissingPackageSelection(selection, { customPackages, carrierPackages, carrierReady })
    ) {
      return missingPackageTypeReason(selection);
    }
  }
  return null;
}
