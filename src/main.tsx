function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function speedUpRoomPolling() {
  const originalSetInterval = window.setInterval.bind(window);

  window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const nextTimeout = timeout === 2500 ? 500 : timeout;
    return originalSetInterval(handler, nextTimeout, ...args);
  }) as typeof window.setInterval;
}

function showFatalError(error: unknown) {
  console.error('FACE_REVEAL_FATAL:', error);

  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  const root = document.getElementById('root');

  if (!root) return;

  root.innerHTML = `
    <main class="boot-fallback">
      <section class="boot-card">
        <span class="boot-pill">Setup</span>
        <h1>App could not load.</h1>
        <p>${escapeHtml(message)}</p>
      </section>
    </main>
  `;
}

window.addEventListener('error', (event) => showFatalError(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => showFatalError(event.reason));

async function boot() {
  try {
    speedUpRoomPolling();

    const rootElement = document.getElementById('root');
    if (!rootElement) throw new Error('Root element was not found.');

    await Promise.all([
      import('./polish.css'),
      import('./clean.css'),
    ]);

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
