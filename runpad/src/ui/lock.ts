import { api, type PadInfo } from '../api';
import { dropToken, saveToken } from '../tokens';
import { h, toast } from '../util';
import { openDialog } from './dialog';

/** Form that exchanges a password for a token. Calls `done` after a successful unlock. */
export function unlockForm(path: string, done: () => void, autofocus = true): HTMLFormElement {
  const pw = h('input.input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Password', placeholder: 'Password', required: true }) as HTMLInputElement;
  const error = h('p.form-error', { role: 'alert' });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Unlock');
  const form = h('form.unlock-form', null, h('div.inline-field', null, pw, submit), error) as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.toggleAttribute('disabled', true);
    error.textContent = '';
    try {
      const res = await api.unlock(path, pw.value);
      saveToken(res.lockPath, res.token);
      toast('Unlocked on this browser', 'success');
      done();
    } catch (err) {
      error.textContent = (err as Error).message;
      pw.select();
    } finally {
      submit.toggleAttribute('disabled', false);
    }
  });
  if (autofocus) setTimeout(() => pw.focus(), 0);
  return form;
}

function lockForm(path: string, done: () => void, current?: 'readonly' | 'private'): HTMLFormElement {
  const mode = (value: string, title: string, text: string) =>
    h('label.radio-card', null, h('input', { type: 'radio', name: 'mode', value, checked: (current ?? 'readonly') === value }), h('span', null, h('strong', null, title), h('small', null, text)));
  const pw = h('input.input', { type: 'password', autocomplete: 'new-password', minlength: '4', required: true, 'aria-label': 'Password' }) as HTMLInputElement;
  const pw2 = h('input.input', { type: 'password', autocomplete: 'new-password', minlength: '4', required: true, 'aria-label': 'Repeat password' }) as HTMLInputElement;
  const error = h('p.form-error', { role: 'alert' });
  const submit = h('button.btn.primary', { type: 'submit' }, current ? 'Save new lock' : 'Lock pad');
  const form = h(
    'form.lock-form',
    null,
    h('div.radio-group', { role: 'radiogroup', 'aria-label': 'Who can see the pad' }, mode('readonly', 'Read-only', 'Anyone with the link can read it and run it; editing needs the password.'), mode('private', 'Private', 'Reading needs the password too.')),
    h('label.field', null, h('span', null, 'Password'), pw),
    h('label.field', null, h('span', null, 'Repeat password'), pw2),
    h('p.hint', null, `The lock also covers every sub-pad of /${path}. There is no way to recover a forgotten password, so keep it somewhere safe.`),
    error,
    h('div.form-actions', null, submit),
  ) as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (pw.value !== pw2.value) {
      error.textContent = 'The passwords do not match.';
      return;
    }
    const chosen = (form.querySelector('input[name=mode]:checked') as HTMLInputElement).value as 'readonly' | 'private';
    submit.toggleAttribute('disabled', true);
    try {
      const res = await api.lock(path, pw.value, chosen);
      saveToken(path, res.token);
      toast(chosen === 'private' ? 'Pad is now private' : 'Pad is now read-only for others', 'success');
      done();
    } catch (err) {
      error.textContent = (err as Error).message;
    } finally {
      submit.toggleAttribute('disabled', false);
    }
  });
  setTimeout(() => pw.focus(), 0);
  return form;
}

/** The lock dialog: lock, unlock, change or remove a pad's password. */
export function openLockDialog(path: string, info: PadInfo, onChanged: () => void): void {
  const d = openDialog(info.lock ? 'Pad lock' : 'Lock this pad');
  const finish = () => {
    d.close();
    onChanged();
  };
  const lock = info.lock;
  if (!lock) {
    d.body.append(h('p', null, 'Pads are open to anyone who knows the address. Add a password to keep others from changing or reading this one.'), lockForm(path, finish));
    return;
  }
  const where = lock.path === path ? 'This pad' : `This pad is inside /${lock.path}, which`;
  const modeText = lock.mode === 'private' ? 'is private' : 'is read-only for people without the password';
  d.body.append(h('p', null, `${where} ${modeText}.`));
  if (!info.canWrite) {
    d.body.append(h('p', null, 'Enter the password to edit it on this browser.'), unlockForm(path, finish));
    return;
  }
  d.body.append(h('p.ok-note', null, 'You have unlocked it on this browser.'));
  const forget = h('button.btn', { type: 'button' }, 'Lock again on this browser');
  forget.addEventListener('click', () => {
    dropToken(lock.path);
    toast('Forgot the password on this browser', 'info');
    finish();
  });
  d.footer.append(forget);
  if (info.canManageLock) {
    const change = h('button.btn', { type: 'button' }, 'Change password');
    change.addEventListener('click', () => {
      d.body.replaceChildren(lockForm(path, finish, lock.mode));
      d.footer.replaceChildren();
    });
    const remove = h('button.btn.danger', { type: 'button' }, 'Remove lock');
    remove.addEventListener('click', async () => {
      try {
        await api.removeLock(path);
        dropToken(path);
        toast('Lock removed: anyone with the link can edit again', 'success');
        finish();
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    });
    d.footer.append(change, remove);
  }
}
