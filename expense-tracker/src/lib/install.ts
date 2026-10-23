import { Capacitor } from '@capacitor/core';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const isNative = Capacitor.isNativePlatform();

/** The single-file preview build (`npm run build:demo`), which runs inside a locked-down frame. */
export const isDemo = import.meta.env.MODE === 'demo';

/** Where the newest Android build is published by the workflow. */
export const APK_RELEASE_URL = 'https://github.com/lakshmang007/claude/releases/tag/expense-tracker-latest';

export function isStandalone(): boolean {
  return isNative || window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

// Chrome fires this once, possibly before React mounts, so it is caught at load.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferred = event as BeforeInstallPromptEvent;
  emit();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  emit();
});

export function canPromptInstall(): boolean {
  return deferred !== null;
}

export function onInstallChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shows the browser's install dialog. Resolves true if the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  emit();
  return outcome === 'accepted';
}
