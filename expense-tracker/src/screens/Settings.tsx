import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { ScreenProps } from '../App';
import type { ThemePref, TxType } from '../types';
import { useFeedback } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { ScreenHeader } from '../components/ScreenHeader';
import { toCSV } from '../lib/csv';
import { todayISO } from '../lib/dates';
import { createInitialData } from '../lib/defaults';
import { saveTextFile } from '../lib/files';
import { APK_RELEASE_URL, canPromptInstall, isDemo, isIOS, isStandalone, onInstallChange, promptInstall } from '../lib/install';
import { amountToInput, currencyLabel, CURRENCIES, formatMoney, parseAmount } from '../lib/money';
import { SAMPLE_PREFIX } from '../lib/sample';
import { parseBackup, serializeBackup } from '../lib/storage';
import { useStore } from '../store';

/** An amount box that saves when it loses focus or Enter is pressed. Empty clears the limit. */
function LimitInput({ value, onSave, label }: { value: number | null; onSave: (limit: number | null) => void; label: string }) {
  const [text, setText] = useState(value ? amountToInput(value) : '');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(value ? amountToInput(value) : ''), [value]);
  const commit = () => {
    if (text.trim() === '') {
      setInvalid(false);
      if (value !== null) onSave(null);
      return;
    }
    const parsed = parseAmount(text);
    setInvalid(parsed === null);
    if (parsed !== null && parsed !== value) onSave(parsed);
  };
  return (
    <input
      className="limit-input"
      inputMode="decimal"
      placeholder="No limit"
      value={text}
      aria-label={label}
      aria-invalid={invalid || undefined}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
    />
  );
}

export function Settings({ openCategory, openBalance, goTab }: ScreenProps) {
  const store = useStore();
  const { notify, confirm } = useFeedback();
  const { transactions, categories, categoryBudgets, settings } = store.data;
  const fileInput = useRef<HTMLInputElement>(null);
  const [installable, setInstallable] = useState(canPromptInstall());
  useEffect(() => onInstallChange(() => setInstallable(canPromptInstall())), []);
  const samples =
    transactions.filter((tx) => tx.id.startsWith(SAMPLE_PREFIX)).length +
    store.data.savings.filter((s) => s.id.startsWith(SAMPLE_PREFIX)).length +
    store.data.debts.filter((d) => d.id.startsWith(SAMPLE_PREFIX)).length;
  const expenseCategories = categories.filter((c) => c.type === 'expense');

  const run = async (task: () => Promise<void>) => {
    try {
      await task();
    } catch (error) {
      notify(`Couldn't do that: ${(error as Error).message ?? error}`);
    }
  };

  const exportCSV = () =>
    run(() => saveTextFile(`expenses-${todayISO()}.csv`, toCSV(transactions, categories, settings.currency, settings.openingBalance, store.data.debts), 'text/csv'));

  const backup = () =>
    run(() => saveTextFile(`expense-tracker-backup-${todayISO()}.json`, serializeBackup(store.data), 'application/json'));

  const restore = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = parseBackup(await file.text());
      const ok = await confirm({
        title: 'Restore this backup?',
        message: `It has ${data.transactions.length} transactions. It replaces everything in the app now (${transactions.length} transactions).`,
        confirmLabel: 'Restore',
        danger: true,
      });
      if (!ok) return;
      store.replaceAll(data);
      notify('Backup restored');
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const removeSamples = async () => {
    const ok = await confirm({
      title: 'Remove sample data?',
      message: `Deletes the ${samples} sample entries and the sample starting amount, so set the money you have again afterwards. Anything you added yourself stays.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    store.replaceAll({
      ...store.data,
      transactions: transactions.filter((tx) => !tx.id.startsWith(SAMPLE_PREFIX)),
      savings: store.data.savings.filter((s) => !s.id.startsWith(SAMPLE_PREFIX)),
      debts: store.data.debts.filter((d) => !d.id.startsWith(SAMPLE_PREFIX)),
      settings: { ...settings, openingBalance: 0 },
    });
    notify('Sample data removed');
  };

  const eraseAll = async () => {
    const ok = await confirm({
      title: 'Erase everything?',
      message: `Deletes all ${transactions.length} transactions, your savings, what people owe and are owed, categories, budgets and the money you have from this device. Make a backup first if you might want them back.`,
      confirmLabel: 'Erase',
      danger: true,
    });
    if (!ok) return;
    store.replaceAll(createInitialData(settings.currency));
    notify('Everything erased');
  };

  const categoryList = (type: TxType) => (
    <ul className="settings-list">
      {categories
        .filter((c) => c.type === type)
        .map((c) => (
          <li key={c.id}>
            <button className="settings-row" onClick={() => openCategory(c.id, type)}>
              <span className="tx-icon" aria-hidden="true">
                {c.icon}
              </span>
              <span className="settings-row-text">{c.name}</span>
              <Icon name="right" size={18} />
            </button>
          </li>
        ))}
      <li>
        <button className="settings-row settings-row-add" onClick={() => openCategory(undefined, type)}>
          <span className="tx-icon" aria-hidden="true">
            <Icon name="plus" size={18} />
          </span>
          <span className="settings-row-text">Add {type} category</span>
        </button>
      </li>
    </ul>
  );

  return (
    <div className="screen-inner">
      <ScreenHeader
        title="Settings"
        action={
          <button className="link-btn" onClick={() => goTab('home')}>
            Done
          </button>
        }
      />

      {isDemo && (
        <section className="card install">
          <Icon name="phone" />
          <div>
            <h2>This is a preview</h2>
            <p>Entries you make here stay in this browser. Backup and CSV export only work in the installed app.</p>
            <a className="btn btn-primary" href={APK_RELEASE_URL} target="_blank" rel="noreferrer">
              Get the Android app
            </a>
          </div>
        </section>
      )}

      {!isDemo && !isStandalone() && (installable || isIOS()) && (
        <section className="card install">
          <Icon name="phone" />
          <div>
            <h2>Install on your phone</h2>
            {installable ? (
              <>
                <p>Adds Expense Tracker to your home screen. It opens full screen and works offline.</p>
                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    if (await promptInstall()) notify('Installed. Open it from your home screen.');
                  }}
                >
                  Install app
                </button>
              </>
            ) : (
              <p>
                In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
              </p>
            )}
          </div>
        </section>
      )}

      <section className="card">
        <h2>Preferences</h2>
        <div className="limit-row">
          <span>Money you have</span>
          <button className="btn btn-outline btn-small" onClick={openBalance}>
            {formatMoney(store.balances.now, settings.currency)}
          </button>
        </div>
        <label className="field">
          <span>Currency</span>
          <select value={settings.currency} onChange={(event) => store.updateSettings({ currency: event.target.value })}>
            {(CURRENCIES.includes(settings.currency) ? CURRENCIES : [settings.currency, ...CURRENCIES]).map((code) => (
              <option key={code} value={code}>
                {currencyLabel(code)}
              </option>
            ))}
          </select>
          <small>Changes the symbol only. Amounts are not converted.</small>
        </label>
        <div className="field">
          <span id="theme-label">Theme</span>
          <div className="segmented" role="radiogroup" aria-labelledby="theme-label">
            {(['system', 'light', 'dark'] as ThemePref[]).map((theme) => (
              <button
                key={theme}
                role="radio"
                aria-checked={settings.theme === theme}
                className={settings.theme === theme ? 'active' : ''}
                onClick={() => store.updateSettings({ theme })}
              >
                {theme === 'system' ? 'Auto' : theme === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Budgets</h2>
        <div className="limit-row">
          <span>Monthly budget</span>
          <LimitInput
            label="Monthly budget"
            value={settings.monthlyBudget}
            onSave={(monthlyBudget) => {
              store.updateSettings({ monthlyBudget });
              notify(monthlyBudget ? 'Monthly budget saved' : 'Monthly budget removed');
            }}
          />
        </div>
        <details className="disclosure">
          <summary>
            Limits per category
            {Object.keys(categoryBudgets).length > 0 && <span className="badge">{Object.keys(categoryBudgets).length}</span>}
          </summary>
          {expenseCategories.map((c) => (
            <div className="limit-row" key={c.id}>
              <span>
                <span aria-hidden="true">{c.icon}</span> {c.name}
              </span>
              <LimitInput label={`${c.name} limit`} value={categoryBudgets[c.id] ?? null} onSave={(limit) => store.setCategoryBudget(c.id, limit)} />
            </div>
          ))}
        </details>
      </section>

      <section className="card">
        <h2>Expense categories</h2>
        {categoryList('expense')}
        <h2 className="spaced">Income categories</h2>
        {categoryList('income')}
      </section>

      <section className="card">
        <h2>Your data</h2>
        <p className="muted">
          Saved only on this device{store.saved ? '' : ' (but saving is failing: storage is full or blocked)'}. Back up now and
          then, or before you change phones.
        </p>
        <div className="data-actions">
          <button className="btn btn-outline" onClick={backup}>
            <Icon name="download" size={18} /> Back up
          </button>
          <button className="btn btn-outline" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={18} /> Restore
          </button>
          <button className="btn btn-outline" onClick={exportCSV} disabled={transactions.length === 0}>
            <Icon name="file" size={18} /> Export CSV
          </button>
        </div>
        <input ref={fileInput} type="file" hidden onChange={restore} />
        {samples > 0 && (
          <button className="btn btn-ghost btn-block" onClick={removeSamples}>
            Remove sample data
          </button>
        )}
        <button className="btn btn-ghost btn-danger-text btn-block" onClick={eraseAll} disabled={
            transactions.length === 0 &&
            store.data.savings.length === 0 &&
            store.data.debts.length === 0 &&
            settings.openingBalance === 0 &&
            Object.keys(categoryBudgets).length === 0
          }>
          <Icon name="trash" size={18} /> Erase everything
        </button>
      </section>

      <p className="about">Expense Tracker {__APP_VERSION__} · works offline · no account, no ads</p>
    </div>
  );
}
