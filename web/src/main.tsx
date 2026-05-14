import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

// StrictMode stays on. All effect setup paths in this app must be
// idempotent — xterm instances live in a Map keyed by claudeUuid outside
// React's tree, so the double-mount in dev doesn't create duplicate PTYs.
const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
