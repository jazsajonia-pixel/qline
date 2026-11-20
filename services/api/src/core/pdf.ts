/**
 * Minimal text PDF writer (docs/22 ADR-C8): standard Helvetica / Helvetica-Bold, WinAnsi text, A4, automatic line wrap
 * and page breaks. Deterministic: the same blocks always give the same bytes (no dates, no random ids), so a stored
 * SHA-256 can prove a regenerated PDF is the one that was issued.
 * shortcut: widths are a fixed per-character estimate, not real font metrics; switch to pdf-lib if layout must be exact.
 */
export type PdfBlock = { kind: 'title' | 'heading' | 'text' | 'mono'; text: string };

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;
const STYLE = {
  title: { font: 'F2', size: 18, lead: 26, before: 0 },
  heading: { font: 'F2', size: 12.5, lead: 18, before: 10 },
  text: { font: 'F1', size: 10.5, lead: 14.5, before: 0 },
  mono: { font: 'F3', size: 9, lead: 12, before: 0 },
} as const;
// Average glyph width as a share of the font size (Courier is exactly 0.6; Helvetica averages ~0.5, bold a bit more).
const WIDTH = { F1: 0.52, F2: 0.58, F3: 0.6 } as const;

// Unicode → WinAnsi for the characters people actually type; everything else outside Latin-1 becomes '?'.
const WIN: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
function encode(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const b = WIN[ch] ?? (cp >= 0x20 && cp <= 0x7e ? cp : cp >= 0xa0 && cp <= 0xff ? cp : 0x3f);
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b > 0x7e) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out;
}

/** Wraps text to the width, keeping each line's leading indent (also on its continuation lines); long words are broken. */
export function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n')) {
    const indent = raw.match(/^ */)![0].slice(0, Math.floor(maxChars / 2));
    const room = maxChars - indent.length;
    let line = '';
    const push = (l: string) => lines.push(indent + l);
    for (let word of raw.trim().split(/ +/)) {
      while (word.length > room) {
        if (line) push(line), (line = '');
        push(word.slice(0, room));
        word = word.slice(room);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= room) line += ' ' + word;
      else push(line), (line = word);
    }
    lines.push(line ? indent + line : '');
  }
  return lines;
}

export function textPdf(blocks: PdfBlock[], footer = ''): Uint8Array {
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  for (const b of blocks) {
    const st = STYLE[b.kind];
    const maxChars = Math.floor((PAGE_W - 2 * MARGIN) / (st.size * WIDTH[st.font]));
    y -= st.before;
    for (const line of wrap(b.text, maxChars)) {
      if (y - st.lead < MARGIN + 20) pages.push([]), (y = PAGE_H - MARGIN);
      y -= st.lead;
      if (line) pages[pages.length - 1]!.push(`BT /${st.font} ${st.size} Tf ${MARGIN} ${y.toFixed(1)} Td (${encode(line)}) Tj ET`);
    }
  }
  const objs: string[] = [];
  const add = (body: string) => objs.push(body); // object number = new length
  const catalog = add('');
  const pagesObj = add('');
  const fonts = [add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'), add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'), add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>')];
  const res = `<< /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R /F3 ${fonts[2]} 0 R >> >>`;
  const kids: number[] = [];
  pages.forEach((ops, i) => {
    const foot = `BT /F1 8 Tf ${MARGIN} 30 Td (${encode(`${footer}${footer ? '  ·  ' : ''}Page ${i + 1} of ${pages.length}`)}) Tj ET`;
    const stream = [...ops, foot].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${res} /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
