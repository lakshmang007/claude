import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

interface Feedback {
  notify(message: string, action?: Toast['action']): void;
  confirm(options: Omit<ConfirmRequest, 'resolve'>): Promise<boolean>;
}

const FeedbackContext = createContext<Feedback | null>(null);

/** Toasts with an optional action (Undo), and an in-app confirm dialog. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const nextId = useRef(1);

  const notify = useCallback<Feedback['notify']>((message, action) => {
    setToast({ id: nextId.current++, message, action });
  }, []);

  const confirm = useCallback<Feedback['confirm']>(
    (options) => new Promise<boolean>((resolve) => setRequest({ ...options, resolve })),
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), toast.action ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const answer = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };

  // Back closes the dialog as "no", like Cancel.
  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && answer(false);
    const onPop = () => answer(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
    };
  });

  return (
    <FeedbackContext.Provider value={{ notify, confirm }}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="toast" key={toast.id}>
            <span>{toast.message}</span>
            {toast.action && (
              <button
                className="toast-action"
                onClick={() => {
                  toast.action?.run();
                  setToast(null);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </div>
      {request && (
        <div className="backdrop backdrop-center" onClick={() => answer(false)}>
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-message"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="confirm-title">{request.title}</h2>
            <p id="confirm-message">{request.message}</p>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={() => answer(false)}>
                Cancel
              </button>
              <button className={`btn ${request.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => answer(true)} autoFocus>
                {request.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): Feedback {
  const feedback = useContext(FeedbackContext);
  if (!feedback) throw new Error('useFeedback must be used inside <FeedbackProvider>');
  return feedback;
}
