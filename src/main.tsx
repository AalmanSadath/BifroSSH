import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { useAppStore } from './store/appStore';
import './index.css';

document.addEventListener('contextmenu', (e) => e.preventDefault());

// Nothing else catches these: a throw in an event handler or a promise nobody
// awaited never reaches the error boundary, and until now went to a console
// the user cannot see. Kept with the rest so a bug report can include them.
window.addEventListener('error', (e) => {
  useAppStore.getState().recordError('uncaught', e.error instanceof Error ? e.error.message : e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason: unknown = e.reason;
  useAppStore.getState().recordError('unhandled promise', reason instanceof Error ? reason.message : String(reason));
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
