import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string | null;
}

/**
 * Catches a render or lifecycle error anywhere below it.
 *
 * Without one, React unmounts the entire tree on an uncaught error and leaves
 * an empty page: the window goes black, including the parts that were working,
 * and nothing says what happened. A blank window is the least diagnosable
 * failure a desktop app has, and the terminal, SFTP and tunnel panels all run
 * enough third-party code that one is worth having.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('BifroSSH hit an unhandled error', error, info.componentStack);
    this.setState({ stack: info.componentStack ?? null });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    const report = [error.stack ?? String(error), stack ?? ''].join('\n\n').trim();

    return (
      <div className="crash-screen">
        <div className="crash-card">
          <h1>BifroSSH hit an error</h1>
          <p className="form-hint">
            Your saved data is untouched. Reloading rebuilds the window; any open sessions are
            disconnected.
          </p>
          <p className="crash-message">{String(error)}</p>
          <textarea className="crash-stack" readOnly value={report} spellCheck={false} />
          <div className="crash-actions">
            <button
              className="btn-secondary"
              onClick={() => navigator.clipboard.writeText(report).catch(() => {})}
            >
              Copy details
            </button>
            <button className="btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
