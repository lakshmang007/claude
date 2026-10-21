import { Emitter, storageGet, storageSet } from './util';

/** Per-browser preferences, kept in localStorage. */
export interface Settings {
  theme: 'system' | 'light' | 'dark';
  fontSize: number;
  wrap: boolean;
  tabSize: number;
  lineNumbers: boolean;
  name: string;
  color: string;
}

const KEY = 'runpad.settings';
const ADJECTIVES = ['Swift', 'Calm', 'Bright', 'Clever', 'Brave', 'Quiet', 'Lucky', 'Bold', 'Gentle', 'Witty', 'Sunny', 'Keen'];
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Fox', 'Koala', 'Lynx', 'Heron', 'Tiger', 'Dolphin', 'Owl', 'Badger', 'Gecko'];
export const COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#ad7f58'];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

const defaults = (): Settings => ({
  theme: 'system',
  fontSize: 14,
  wrap: window.innerWidth < 760,
  tabSize: 4,
  lineNumbers: true,
  name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
  color: pick(COLORS),
});

class SettingsStore extends Emitter<{ change: [Settings] }> {
  value: Settings;

  constructor() {
    super();
    this.value = { ...defaults(), ...storageGet<Partial<Settings>>(KEY, {}) };
    storageSet(KEY, this.value);
  }

  update(patch: Partial<Settings>): void {
    this.value = { ...this.value, ...patch };
    storageSet(KEY, this.value);
    applyTheme(this.value);
    this.emit('change', this.value);
  }
}

export const settings = new SettingsStore();

const dark = window.matchMedia('(prefers-color-scheme: dark)');

export function isDark(s: Settings = settings.value): boolean {
  return s.theme === 'dark' || (s.theme === 'system' && dark.matches);
}

export function applyTheme(s: Settings = settings.value): void {
  document.documentElement.dataset.theme = isDark(s) ? 'dark' : 'light';
}

dark.addEventListener('change', () => {
  applyTheme();
  settings.emit('change', settings.value);
});
applyTheme();
