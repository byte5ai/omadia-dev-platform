import { useEffect, useRef, type ReactElement } from 'react';

import { Button } from '@/components/ui/Button';
import { BORDER, cx } from '@/lib/cx';

/**
 * Minimal modal-confirm, ported from `web-ui/app/_components/ConfirmDialog.tsx`.
 *
 * Behaviour is unchanged — focus opens on Cancel (deliberate friction before a
 * destructive action, so Enter cancels and confirming needs an explicit Tab or
 * click), Escape cancels, a backdrop click cancels.
 *
 * Only the classes changed. Core paints the backdrop with
 * `bg-[color:var(--bg-modal-overlay)]`, an arbitrary value; the served
 * vocabulary has no overlay token, so `bg-bg-soft` stands in. It is opaque
 * rather than translucent — the dialog still reads as modal because it is
 * `fixed inset-0` above everything, but the content behind it is hidden rather
 * than dimmed. Widening the vocabulary with an overlay token is the real fix
 * and is listed in the P2 report.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger` paints the confirm button red. */
  tone?: 'neutral' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = 'neutral',
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement | null {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-soft p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className={cx(
          'w-full max-w-md rounded-lg bg-bg-elevated p-4 shadow-lg',
          BORDER,
          'border-border',
        )}
      >
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-fg-strong">
          {title}
        </h2>
        {body && <p className="mt-2 text-sm text-fg-muted">{body}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
