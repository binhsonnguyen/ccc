import { Component, type ReactNode } from 'react';

interface State {
  err: Error | null;
}

// Catch render-time exceptions anywhere in the tree. Without this an
// xterm or component throw unmounts the whole app, killing every WS +
// open tab silently. We surface the error and offer reload.
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error('UI crashed:', err, info);
  }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="error-boundary">
        <div className="overlay-card">
          <h2>Something broke</h2>
          <p>{this.state.err.message}</p>
          <div className="overlay-actions">
            <button className="btn primary" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
