/** Content handoff run 3: the minimal text PDF writer (src/core/pdf.ts). Pure; no database. */
import { describe, expect, it } from 'vitest';
import { textPdf, wrap } from '../src/core/pdf';

describe('text PDF writer', () => {
  it('wraps on words, breaks very long words and keeps indents', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrap('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl']);
    expect(wrap('  a b c d e', 5)).toEqual(['  a b', '  c d', '  e']);
    expect(wrap('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });

  it('escapes PDF syntax and maps text to WinAnsi; output is deterministic', async () => {
    const blocks = [{ kind: 'text' as const, text: 'a (b) \\ c – “d” é 😀' }];
    const a = textPdf(blocks, 'foot');
    const b = textPdf(blocks, 'foot');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const s = Buffer.from(a).toString('latin1');
    expect(s).toContain('(a \\(b\\) \\\\ c \\226 \\223d\\224 \\351 ?) Tj');
    expect(s).not.toMatch(/CreationDate|ModDate/);
    const { extractText, getDocumentProxy } = await import('unpdf');
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(a)), { mergePages: true });
    expect(text).toContain('a (b) \\ c – “d” é ?');
  });

  it('has a valid cross-reference table', () => {
    const s = Buffer.from(textPdf([{ kind: 'title', text: 'x' }])).toString('latin1');
    const xref = Number(s.match(/startxref\n(\d+)/)![1]);
    expect(s.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(s.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });
});
