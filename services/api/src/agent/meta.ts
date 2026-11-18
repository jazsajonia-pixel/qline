/**
 * v1.6 reply metadata. The model writes its full answer for the screen, then one hidden block:
 *   <qline-meta>{"speech":"…","suggestions":["…","…"]}</qline-meta>
 * `speech` is what the voice says (short, conversational — not a reading of the text);
 * `suggestions` are follow-up prompts shown as chips under the answer.
 * The block is never shown: MetaFilter removes it from the token stream as it arrives.
 */
export const META_OPEN = '<qline-meta>';
export const META_CLOSE = '</qline-meta>';

export const META_INSTRUCTIONS = `Voice and follow-ups: after your written answer (only in your final message, after any tool use), add exactly one block at the very end:
${META_OPEN}{"speech": "...", "suggestions": ["...", "..."]}${META_CLOSE}
- "speech" is what you SAY out loud when the user listens: 1–2 short, natural sentences (at most about 35 words). Give the gist or the key number and point to the screen for details ("I've put the full list in the chat."). No markdown, lists, links, IDs or emojis. Do not read the written answer.
- "suggestions" are 2–3 short follow-up requests the user is likely to send next, written as the user would say them (at most 60 characters each), specific to this conversation and to what Qline can do.
- The written answer can be as detailed as needed; the speech stays short.`;

export interface ReplyMeta {
  speech: string;
  suggestions: string[];
}

/** Streams text through, holding back anything from `<qline-meta>` on (and partial prefixes of it). */
export class MetaFilter {
  private buf = '';
  private inMeta = false;
  raw = '';

  /** Returns the part of `chunk` that is safe to show now. */
  push(chunk: string): string {
    this.raw += chunk;
    if (this.inMeta) return '';
    this.buf += chunk;
    const at = this.buf.indexOf(META_OPEN);
    if (at >= 0) {
      const out = this.buf.slice(0, at);
      this.buf = '';
      this.inMeta = true;
      return out;
    }
    // Keep back a tail that could be the start of the marker.
    let keep = 0;
    for (let k = Math.min(META_OPEN.length - 1, this.buf.length); k > 0; k--) {
      if (META_OPEN.startsWith(this.buf.slice(-k))) {
        keep = k;
        break;
      }
    }
    const out = this.buf.slice(0, this.buf.length - keep);
    this.buf = this.buf.slice(this.buf.length - keep);
    return out;
  }

  /** Flushes held-back text at the end of a turn (a false alarm such as a lone "<"). */
  flush(): string {
    const out = this.inMeta ? '' : this.buf;
    this.buf = '';
    this.inMeta = false;
    return out;
  }
}

/** Removes every meta block (complete or cut off) from stored text. */
export function stripMeta(text: string): string {
  return text.replace(/<qline-meta>[\s\S]*?(<\/qline-meta>|$)/g, '').trimEnd();
}

const clean = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>|~]/g, '')
    .replace(/^\s*[-•\d.)]+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A short spoken line when the model gave none: the first sentence or two, capped. */
export function briefSpeech(text: string, maxChars = 220): string {
  const t = clean(stripMeta(text));
  if (!t) return '';
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [t];
  let out = '';
  let n = 0;
  for (const s of sentences) {
    if ((out + s).length > maxChars && out) break;
    out += s;
    n += 1;
    if (n >= 2 || out.length > 80) break;
  }
  out = out.trim();
  return out.length > maxChars ? `${out.slice(0, maxChars - 1).replace(/\s+\S*$/, '')}…` : out;
}

/** Parses the last meta block in the raw model output; falls back to a brief of the text. */
export function parseMeta(raw: string, shown: string): ReplyMeta {
  const blocks = [...raw.matchAll(/<qline-meta>([\s\S]*?)(<\/qline-meta>|$)/g)];
  let speech = '';
  let suggestions: string[] = [];
  const last = blocks.at(-1)?.[1];
  if (last) {
    try {
      const j = JSON.parse(last.trim());
      if (typeof j.speech === 'string') speech = clean(j.speech).slice(0, 400);
      if (Array.isArray(j.suggestions)) {
        suggestions = [...new Set(j.suggestions.filter((x: unknown): x is string => typeof x === 'string').map((x: string) => clean(x).slice(0, 80)).filter((x: string) => x.length >= 2))].slice(0, 3) as string[];
      }
    } catch {
      /* malformed: fall back below */
    }
  }
  return { speech: speech || briefSpeech(shown), suggestions };
}
