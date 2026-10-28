/**
 * Live appearance from the host page (byte5ai/omadia#1480).
 *
 * Every theme, palette or language switch in the shell used to reload this
 * document, losing the operator's open screen. Core now keeps the frame for a
 * bundle that announces `ready` and posts the change instead. These tests pin
 * the bundle half: who is heard, what is accepted, and that a locale change
 * re-renders in place.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider, useLocale } from '@/lib/i18n';
import {
  APPEARANCE_MESSAGE,
  READY_MESSAGE,
  readAppearanceMessage,
  subscribeToHostAppearance,
  useHostLocale,
} from '@/lib/hostAppearance';

/** A window whose parent is a distinct object, i.e. a framed document. */
function framedWindow(): { win: Window; parent: { postMessage: ReturnType<typeof vi.fn> } } {
  const parent = { postMessage: vi.fn() };
  const win = Object.create(window, {
    parent: { value: parent },
  }) as Window;
  return { win, parent };
}

function hostMessage(source: unknown, data: unknown, origin = window.location.origin): MessageEvent {
  return new MessageEvent('message', { data, origin, source: source as Window });
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-palette');
});

describe('readAppearanceMessage', () => {
  it('accepts the shape core sends', () => {
    expect(
      readAppearanceMessage({ type: APPEARANCE_MESSAGE, theme: 'dark', palette: 'ember', locale: 'de' }),
    ).toEqual({ theme: 'dark', palette: 'ember', locale: 'de' });
  });

  it('validates like the query string: bad theme or palette is dropped, bad locale refuses', () => {
    expect(
      readAppearanceMessage({ type: APPEARANCE_MESSAGE, theme: 'neon', palette: 'x"]{', locale: 'en' }),
    ).toEqual({ theme: null, palette: null, locale: 'en' });
    expect(readAppearanceMessage({ type: APPEARANCE_MESSAGE, theme: 'dark', locale: 'fr' })).toBeNull();
    expect(readAppearanceMessage({ type: 'other', theme: 'dark', locale: 'en' })).toBeNull();
    expect(readAppearanceMessage('dark')).toBeNull();
  });
});

describe('subscribeToHostAppearance', () => {
  it('announces ready to the parent on this origin, after listening', () => {
    const { win, parent } = framedWindow();
    const add = vi.spyOn(window, 'addEventListener');
    const off = subscribeToHostAppearance(() => {}, win);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: READY_MESSAGE }, window.location.origin);
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(
      parent.postMessage.mock.invocationCallOrder[0] ?? 0,
    );
    off();
    add.mockRestore();
  });

  it('hears only the parent on this origin', () => {
    const { win, parent } = framedWindow();
    const onChange = vi.fn();
    const off = subscribeToHostAppearance(onChange, win);
    const msg = { type: APPEARANCE_MESSAGE, theme: 'dark', palette: 'ember', locale: 'de' };
    window.dispatchEvent(hostMessage(parent, msg, 'https://evil.example'));
    window.dispatchEvent(hostMessage(window, msg));
    expect(onChange).not.toHaveBeenCalled();
    window.dispatchEvent(hostMessage(parent, msg));
    expect(onChange).toHaveBeenCalledWith({ theme: 'dark', palette: 'ember', locale: 'de' });
    off();
    window.dispatchEvent(hostMessage(parent, msg));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside a frame', () => {
    const onChange = vi.fn();
    const off = subscribeToHostAppearance(onChange, window);
    window.dispatchEvent(hostMessage(window, { type: APPEARANCE_MESSAGE, theme: 'dark', locale: 'de' }));
    expect(onChange).not.toHaveBeenCalled();
    off();
  });
});

describe('useHostLocale', () => {
  it('switches the locale and re-applies <html> attributes in place', () => {
    // jsdom's own window has `parent === window`; frame it for this test.
    const parent = { postMessage: vi.fn() };
    const spy = vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
    function Probe(): React.ReactElement {
      const locale = useHostLocale('en');
      return (
        <I18nProvider locale={locale}>
          <Label />
        </I18nProvider>
      );
    }
    function Label(): React.ReactElement {
      return <p data-testid="probe">{useLocale()}</p>;
    }
    render(<Probe />);
    const before = screen.getByTestId('probe');
    expect(before.textContent).toBe('en');
    act(() => {
      window.dispatchEvent(
        hostMessage(parent, { type: APPEARANCE_MESSAGE, theme: 'dark', palette: 'ember', locale: 'de' }),
      );
    });
    expect(screen.getByTestId('probe')).toBe(before);
    expect(screen.getByTestId('probe').textContent).toBe('de');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-palette')).toBe('ember');
    expect(document.documentElement.getAttribute('lang')).toBe('de');
    spy.mockRestore();
  });
});
