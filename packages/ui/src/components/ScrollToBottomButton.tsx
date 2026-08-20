import type { ReactElement } from 'react';

import { Button } from '@/components/ui/Button';

/**
 * Floating "jump to bottom" affordance for panes wired to `useStickToBottom`
 * (core issue #404) — shown only while the user has detached from the bottom
 * by scrolling up during a stream.
 *
 * Two changes from core's version, both forced by the plugin contract:
 *
 *  - `lucide-react` is gone. One 16px chevron does not justify an icon
 *    dependency in a bundle that ships inside a plugin ZIP, and `size-4` is
 *    not in the served vocabulary anyway. It is an inline SVG sized by
 *    attributes, which no stylesheet has to know about.
 *  - `bottom-4 left-1/2 -translate-x-1/2` is not expressible: the vocabulary
 *    emits `inset/top/right/bottom/left-{0,auto}` and no transforms. The
 *    button is positioned by a full-width flex row pinned to `bottom-0`
 *    instead, which centres it without a transform.
 */
export function ScrollToBottomButton({
  visible,
  onClick,
  ariaLabel,
}: {
  visible: boolean;
  onClick: () => void;
  ariaLabel: string;
}): ReactElement | null {
  if (!visible) return null;

  return (
    <div className="absolute bottom-0 left-0 right-0 z-10 flex justify-center pb-4">
      <Button
        type="button"
        variant="secondary"
        size="icon"
        pill
        onClick={onClick}
        aria-label={ariaLabel}
        className="shadow-lg"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </Button>
    </div>
  );
}
