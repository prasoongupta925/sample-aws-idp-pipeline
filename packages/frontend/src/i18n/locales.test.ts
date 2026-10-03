// @vitest-environment node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import en from './locales/en.json';
import { SUPPORTED_LANGS, resolveLanguage } from './languages';

type Tree = { [key: string]: string | Tree };

function strings(tree: Tree): string[] {
  return Object.values(tree).flatMap((v) =>
    typeof v === 'string' ? [v] : strings(v),
  );
}

describe('locales', () => {
  it('ships the English UI only', () => {
    expect([...SUPPORTED_LANGS]).toEqual(['en']);
    expect(readdirSync(join(__dirname, 'locales')).sort()).toEqual(['en.json']);
  });

  it('has no Korean or Japanese text in en', () => {
    const cjk = /[\u3040-\u30ff\u3130-\u318f\uac00-\ud7af]/;
    expect(strings(en as Tree).filter((s) => cjk.test(s))).toEqual([]);
  });
});

describe('resolveLanguage', () => {
  it.each([
    ['en', 'en'],
    ['en-IN', 'en'],
    ['EN-us', 'en'],
    ['ko', 'en'],
    ['ja-JP', 'en'],
    ['hi', 'en'],
    ['', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ])('%s -> %s', (input, want) => {
    expect(resolveLanguage(input)).toBe(want);
  });
});
