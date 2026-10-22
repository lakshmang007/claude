import { useState, type FormEvent } from 'react';
import type { TxType } from '../types';
import { otherCategoryId } from '../lib/defaults';
import { useStore } from '../store';
import { useFeedback } from './Feedback';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

const EMOJIS = [
  '🍔', '🍕', '☕', '🍺', '🛒', '🥦', '🚌', '🚗', '⛽', '🚕', '✈️', '🏠', '💡', '📱', '🌐', '💊',
  '🏥', '🏋️', '📚', '🎓', '🎬', '🎮', '🎵', '🛍️', '👕', '💄', '🎁', '🐶', '👶', '🔧', '🧾', '💳',
  '🏦', '💼', '💻', '📈', '👛', '💰', '↩️', '🏷️', '📦', '⭐',
];

/** The last character as people see it, so a typed emoji with modifiers stays whole. */
function lastGrapheme(value: string): string {
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  return segments.at(-1)?.segment ?? '';
}

export function CategorySheet({ id, type, onClose }: { id?: string; type: TxType; onClose: () => void }) {
  const store = useStore();
  const { confirm, notify } = useFeedback();
  const existing = id ? store.data.categories.find((c) => c.id === id) : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [icon, setIcon] = useState(existing?.icon ?? '🏷️');
  const [error, setError] = useState<string | null>(null);
  const categoryType = existing?.type ?? type;
  const used = existing ? store.data.transactions.filter((tx) => tx.categoryId === existing.id).length : 0;
  const deletable = existing && existing.id !== otherCategoryId(existing.type);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError('Give the category a name.');
    const clash = store.data.categories.find(
      (c) => c.type === categoryType && c.id !== existing?.id && c.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (clash) return setError(`There is already a category called ${clash.name}.`);
    store.saveCategory({ id: existing?.id, name: trimmed.slice(0, 40), icon, type: categoryType });
    onClose();
  };

  const remove = async () => {
    if (!existing) return;
    const ok = await confirm({
      title: `Delete ${existing.name}?`,
      message: used
        ? `Its ${used} transaction${used === 1 ? '' : 's'} will move to Other.`
        : 'No transactions use it.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    store.deleteCategory(existing.id);
    onClose();
    notify(`Deleted ${existing.name}`);
  };

  return (
    <Sheet
      title={existing ? 'Edit category' : categoryType === 'expense' ? 'New expense category' : 'New income category'}
      onClose={onClose}
      footer={
        <div className="sheet-actions">
          {deletable && (
            <button type="button" className="btn btn-ghost btn-danger-text" onClick={remove}>
              <Icon name="trash" size={18} /> Delete
            </button>
          )}
          <button type="submit" form="category-form" className="btn btn-primary btn-grow">
            Save
          </button>
        </div>
      }
    >
      <form id="category-form" className="tx-form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="category-name">Name</label>
          <input
            id="category-name"
            type="text"
            value={name}
            maxLength={40}
            autoFocus={!existing}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </div>
        <fieldset className="field">
          <legend>Icon</legend>
          <div className="emoji-grid">
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={`emoji-choice ${icon === emoji ? 'active' : ''}`}
                aria-pressed={icon === emoji}
                aria-label={emoji}
                onClick={() => setIcon(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
          <label className="emoji-custom">
            <span>Or type any emoji</span>
            <input
              type="text"
              value={icon}
              onChange={(event) => setIcon(lastGrapheme(event.target.value) || '🏷️')}
              aria-label="Custom emoji"
            />
          </label>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
