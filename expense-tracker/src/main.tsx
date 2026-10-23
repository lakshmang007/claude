import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FeedbackProvider } from './components/Feedback';
import { isDemo, isNative } from './lib/install';
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

if (isDemo) document.documentElement.classList.add('demo');

// The Android app ships its files inside the APK; the web app caches them for offline use.
if (!isNative && !isDemo && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}

// Ask the browser not to clear the data under storage pressure.
if (!isNative && !isDemo && navigator.storage?.persist) {
  navigator.storage.persisted().then((persisted) => persisted || navigator.storage.persist()).catch(() => undefined);
}
