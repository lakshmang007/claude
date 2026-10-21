import './styles.css';
import { normalizePadPath } from '../shared/padpath.js';
import { startPad } from './app';
import { renderLanding } from './landing';
import { applyTheme } from './settings';

applyTheme();
const mount = document.getElementById('app')!;
const padPath = normalizePadPath(location.pathname);
if (padPath) {
  startPad(padPath, mount).catch((err) => {
    console.error(err);
    mount.textContent = `RunPad could not start: ${err.message}`;
  });
} else {
  renderLanding(mount);
}
