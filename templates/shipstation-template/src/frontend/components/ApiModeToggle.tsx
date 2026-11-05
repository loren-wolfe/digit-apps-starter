import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

export type ApiModeChoice = 'v1' | 'v2';

export default function ApiModeToggle({
  value,
  onChange,
  ariaLabel = 'ShipStation API mode',
}: {
  value: ApiModeChoice;
  onChange: (mode: ApiModeChoice) => void;
  ariaLabel?: string;
}) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={value}
      onChange={(_event, next: ApiModeChoice | null) => {
        if (next) onChange(next);
      }}
      aria-label={ariaLabel}
    >
      <ToggleButton value="v2" aria-label="ShipStation V2">
        V2
      </ToggleButton>
      <ToggleButton value="v1" aria-label="ShipStation V1">
        V1
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
