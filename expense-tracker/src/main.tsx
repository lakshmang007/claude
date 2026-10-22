import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FeedbackProvider } from './components/Feedback';
import { isNative } from './lib/install';
import { StoreProvider } from './store';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <FeedbackProvider>
        <App />
      </FeedbackProvider>
    </StoreProvider>
  </StrictMode>,
);

// The Android app ships its files inside the APK; the web app caches them for offline use.
if (!isNative && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}

// Ask the browser not to clear the data under storage pressure.
if (!isNative && navigator.storage?.persist) {
  navigator.storage.persisted().then((persisted) => persisted || navigator.storage.persist()).catch(() => undefined);
}
