function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

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
        <p>${escapeHtml(message)}</p>
        <p>Open DevTools → Console and look for FACE_REVEAL_FATAL.</p>
      </section>
    </main>
  `;
}

window.addEventListener('error', (event) => showFatalError(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => showFatalError(event.reason));

async function boot() {
  try {
    const rootElement = document.getElementById('root');
    if (!rootElement) throw new Error('Root element was not found.');

    await import('./polish.css');

    const [{ default: React }, ReactDOM, { default: App }] = await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('./App'),
    ]);

    ReactDOM.createRoot(rootElement).render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(App),
      ),
    );
  } catch (error) {
    showFatalError(error);
  }
}

void boot();
