import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export default function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Stack spacing={0.75} sx={{ py: 3, px: 1, textAlign: 'center' }}>
      <Typography variant="subtitle1" component="p">
        {title}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 420, mx: 'auto' }}>
        {description}
      </Typography>
    </Stack>
  );
}
