import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './polish.css';

function showFatalError(error: unknown) {
  console.error('FACE_REVEAL_FATAL:', error);

  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  const root = document.getElementById('root');

  if (!root) return;

  root.innerHTML = `
    <main class="boot-fallback">
      <section class="boot-card">
        <span class="boot-pill">Runtime error</span>
        <h1>App failed to load.</h1>
        <p>${message.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>
        <p>Open DevTools → Console and look for FACE_REVEAL_FATAL.</p>
      </section>
    </main>
  `;
}

window.addEventListener('error', (event) => showFatalError(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => showFatalError(event.reason));

try {
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Root element was not found.');

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  showFatalError(error);
}
