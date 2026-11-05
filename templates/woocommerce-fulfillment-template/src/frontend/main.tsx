import { createRoot } from 'react-dom/client';

import { ThemeProvider } from '@heysutton/sdk-react';

import App from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Sutton apps must mount to #root');

createRoot(rootEl).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
