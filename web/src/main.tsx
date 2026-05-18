import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { initThemeEarly } from './lib/themes';
import './styles.css';

// Apply the persisted theme BEFORE React mounts so first paint shows
// the correct chrome. Sets the class on <html>; no localStorage write,
// no terminal walk (no terms exist yet).
initThemeEarly();

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
