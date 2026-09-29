import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/auth/session';

describe('safeNext', () => {
  it('keeps same-site paths with query and hash', () => {
    expect(safeNext('/review/abc?x=1#top')).toBe('/review/abc?x=1#top');
  });
  it('rejects anything that could leave the site', () => {
    for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'https://evil.example', 'evil', '', undefined, 42]) {
      expect(safeNext(bad)).toBe('/inventory');
    }
  });
});
