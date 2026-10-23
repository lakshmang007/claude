import type { ReactNode } from 'react';
import { Icon } from './Icon';

/** A screen's title, with the Settings button (or another action) on the right. */
export function ScreenHeader({ title, onSettings, action }: { title: string; onSettings?: () => void; action?: ReactNode }) {
  return (
    <header className="screen-header">
      <h1>{title}</h1>
      {action}
      {onSettings && (
        <button className="icon-btn" onClick={onSettings} aria-label="Settings">
          <Icon name="settings" />
        </button>
      )}
    </header>
  );
}
