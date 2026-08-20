import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { BORDER, cx } from '@/lib/cx';

/**
 * Lume Button — REWRITTEN, not ported (epic #470 P2).
 *
 * This is the one component the port could not carry across mechanically, and
 * the reason is worth recording because it is the whole point of the C8
 * contract.
 *
 * Core's `web-ui/app/_components/ui/Button.tsx` expresses every one of its
 * variants as an arbitrary value:
 *
 *     primary: 'bg-[color:var(--accent)] text-[color:var(--fg-on-dark)]'
 *     danger:  'border-[color:var(--danger-edge)] … hover:bg-[color:var(--danger)]/8'
 *
 * Inside web-ui that is fine — Tailwind scans that file and emits exactly
 * those classes. A plugin installed at runtime from another repository is
 * never scanned, so those classes do not exist in the sheet core serves, and
 * an unported copy would have rendered every button in the SPA as unstyled
 * text. Core's ingest gate rejects the shape outright.
 *
 * The rewrite is a straight substitution — `bg-[color:var(--accent)]` is
 * `bg-accent` in the vocabulary, and it resolves to the same CSS variable —
 * so the appearance is preserved while the coupling to a build-time scan is
 * not. Four things could not be substituted:
 *
 *  - **Framer Motion.** `whileTap`/`whileHover` need a 40 KB dependency to
 *    animate two properties this bundle cannot express anyway: `scale` and
 *    `y` transforms are not in the vocabulary. The press feel is dropped.
 *    Hover and focus still read, through colour.
 *  - **`transition-colors`.** Absent from the served sheet — see `BORDER` in
 *    `lib/cx.ts` for why that whole declaration emits nothing. Colour changes
 *    are instant rather than eased.
 *  - **`disabled:opacity-60`.** The vocabulary emits `disabled:opacity-50`.
 *  - **``.** A web-ui-only animation class. The busy state now
 *    shows `busyLabel` alone, which is what actually carries the meaning.
 *
 * `size="icon"` and `pill` survive unchanged; both were already token classes.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Pill radius (badge/CTA chips) instead of the default radius.md corner. */
  pill?: boolean;
  /** Stretch to the container width (form submits, full-width CTAs). */
  fullWidth?: boolean;
  /** In-flight: replaces the label with `busyLabel`. */
  busy?: boolean;
  busyLabel?: string;
  children?: ReactNode;
}

const BASE =
  'relative inline-flex items-center justify-center gap-2 font-medium ' +
  'whitespace-nowrap select-none focus-visible:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-bg',
  secondary: `${BORDER} border-border bg-bg-elevated text-fg hover:border-border-strong`,
  ghost: 'bg-transparent text-fg hover:bg-accent-subtle hover:text-accent',
  danger: `${BORDER} border-danger bg-transparent text-danger hover:bg-danger hover:text-bg`,
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-3 py-1 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
  icon: 'p-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    pill = false,
    fullWidth = false,
    busy = false,
    busyLabel,
    disabled,
    type = 'button',
    className,
    children,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled === true || busy;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={busy || undefined}
      className={cx(
        BASE,
        VARIANT[variant],
        SIZE[size],
        pill ? 'rounded-full' : 'rounded-md',
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {busy ? (busyLabel ?? children) : children}
    </button>
  );
});
