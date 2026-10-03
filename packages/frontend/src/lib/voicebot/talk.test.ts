// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  TALK_MODE_KEY,
  defaultTalkMode,
  holdKeyHandlers,
  holdPointerHandlers,
  initialTalkMode,
  isTalkKey,
  isTalkMode,
  micSilenced,
} from './talk';

const media =
  (matches: Record<string, boolean>) =>
  (query: string): { matches: boolean } => ({ matches: !!matches[query] });
const DESKTOP = media({ '(pointer: fine)': true, '(hover: hover)': true });
const PHONE = media({ '(pointer: coarse)': true, '(hover: none)': true });

describe('talk mode', () => {
  it('defaults to hold to talk on a desktop, hands-free on a phone or an old browser', () => {
    expect(defaultTalkMode(DESKTOP)).toBe('ptt');
    expect(defaultTalkMode(PHONE)).toBe('handsfree');
    expect(defaultTalkMode(media({ '(pointer: fine)': true }))).toBe(
      'handsfree',
    );
    expect(defaultTalkMode(undefined)).toBe('handsfree');
    expect(
      defaultTalkMode(() => {
        throw new Error('no matchMedia');
      }),
    ).toBe('handsfree');
  });

  it('keeps a saved choice; junk and blocked storage fall back to the device default', () => {
    const store = (value: string | null) => ({
      getItem: (k: string) => (k === TALK_MODE_KEY ? value : null),
    });
    expect(initialTalkMode(store('handsfree'), DESKTOP)).toBe('handsfree');
    expect(initialTalkMode(store('ptt'), PHONE)).toBe('ptt');
    expect(initialTalkMode(store('loud'), DESKTOP)).toBe('ptt');
    expect(
      initialTalkMode(
        {
          getItem: () => {
            throw new Error('SecurityError');
          },
        },
        PHONE,
      ),
    ).toBe('handsfree');
    expect(isTalkMode('ptt') && isTalkMode('handsfree')).toBe(true);
    expect(isTalkMode('PTT')).toBe(false);
  });

  it('silences the microphone in hold to talk while the button is up', () => {
    expect(micSilenced({ muted: false, talkMode: 'ptt', held: false })).toBe(
      true,
    );
    expect(micSilenced({ muted: false, talkMode: 'ptt', held: true })).toBe(
      false,
    );
    expect(micSilenced({ muted: true, talkMode: 'ptt', held: true })).toBe(
      true,
    );
    expect(
      micSilenced({ muted: false, talkMode: 'handsfree', held: false }),
    ).toBe(false);
  });

  it('Space holds to talk, but not while typing, on auto-repeat or with a modifier', () => {
    const key = (extra = {}) => ({
      code: 'Space',
      repeat: false,
      target: { tagName: 'BUTTON' },
      ...extra,
    });
    expect(isTalkKey(key())).toBe(true);
    expect(isTalkKey(key({ repeat: true }))).toBe(false);
    expect(isTalkKey(key({ metaKey: true }))).toBe(false);
    expect(isTalkKey(key({ target: { tagName: 'TEXTAREA' } }))).toBe(false);
    expect(
      isTalkKey(key({ target: { tagName: 'DIV', isContentEditable: true } })),
    ).toBe(false);
    expect(isTalkKey({ code: 'Enter' })).toBe(false);
    expect(isTalkKey(null)).toBe(false);
  });

  it('Space down / up hold and release, swallowing Space so End is not clicked', () => {
    const held: boolean[] = [];
    const { down, up } = holdKeyHandlers((h) => held.push(h));
    const ev = (extra = {}) => ({
      code: 'Space',
      target: { tagName: 'BUTTON' },
      preventDefault: vi.fn(),
      ...extra,
    });
    const first = ev();
    down(first);
    const repeat = ev({ repeat: true });
    down(repeat);
    const release = ev();
    up(release);
    expect(held).toEqual([true, false]);
    expect(first.preventDefault).toHaveBeenCalled();
    expect(repeat.preventDefault).toHaveBeenCalled(); // no scrolling while held
    expect(release.preventDefault).toHaveBeenCalled();
    const typing = ev({ target: { tagName: 'INPUT' } });
    down(typing);
    up(ev({ code: 'KeyA' }));
    expect(held).toEqual([true, false]);
    expect(typing.preventDefault).not.toHaveBeenCalled();
  });

  it('the hold button: primary press holds (with pointer capture), every way of letting go releases', () => {
    const held: boolean[] = [];
    const h = holdPointerHandlers((v) => held.push(v));
    const setPointerCapture = vi.fn();
    h.onPointerDown({
      button: 2,
      pointerId: 1,
      currentTarget: { setPointerCapture },
    });
    expect(held).toEqual([]); // right click
    h.onPointerDown({
      button: 0,
      pointerId: 7,
      currentTarget: { setPointerCapture },
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    h.onPointerUp();
    h.onPointerDown({
      button: 0,
      pointerId: 8,
      currentTarget: {
        setPointerCapture: () => {
          throw new Error('InvalidPointerId');
        },
      },
    });
    h.onPointerCancel();
    h.onLostPointerCapture();
    expect(held).toEqual([true, false, true, false, false]);
  });
});
