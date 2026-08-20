/**
 * Vitest setup.
 *
 * Deliberately thin. `@testing-library/jest-dom` is not installed: the
 * assertions here are about what a user can READ on the screen, which
 * `getByText` / `queryByText` already express, and every custom matcher added
 * to a suite is another thing that can pass for the wrong reason.
 *
 * `EventSource` does not exist in jsdom. `useDevJobEvents` checks for it and
 * no-ops when absent, so the screens render their non-live state in tests —
 * which is the state a fixture-driven render should be asserting anyway.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
