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

/** Removes every meta block and spoken-line block (complete or cut off) from stored text. */
export function stripMeta(text: string): string {
  return text
    .replace(/<qline-meta>[\s\S]*?(<\/qline-meta>|$)/g, '')
    .replace(/\s*<qline-screen>[ \t]*\n?/g, '\n\n')
    .replace(/<qline-say>[\s\S]*?(<\/qline-say>|$)\s*/g, '')
    .trimEnd();
}

/**
 * Voice v2: early spoken lines. In a voice turn the model starts its reply with
 *   <qline-say>One short spoken sentence.</qline-say>
 * so the phone can start talking while the written answer is still streaming. SayFilter pulls each
 * complete block out of the token stream (it is never shown) and hands back the visible text.
 */
export const SAY_OPEN = '<qline-say>';
export const SAY_CLOSE = '</qline-say>';

export class SayFilter {
  private buf = '';
  private inSay = false;
  private said = '';

  /** Returns the visible part of `chunk` and any spoken lines that just completed. */
  push(chunk: string): { show: string; said: string[] } {
    this.buf += chunk;
    let show = '';
    const said: string[] = [];
    for (;;) {
      if (this.inSay) {
        const end = this.buf.indexOf(SAY_CLOSE);
        if (end < 0) {
          // A runaway block (no close) is capped so it can never swallow the whole answer.
          if (this.buf.length > 600) {
            show += this.buf;
            this.buf = '';
            this.inSay = false;
          }
          break;
        }
        const line = clean(this.buf.slice(0, end)).slice(0, 300);
        if (line) said.push(line);
        this.buf = this.buf.slice(end + SAY_CLOSE.length).replace(/^[ \t]*\n?/, '');
        this.inSay = false;
        continue;
      }
      const at = this.buf.indexOf(SAY_OPEN);
      if (at >= 0) {
        show += this.buf.slice(0, at);
        this.buf = this.buf.slice(at + SAY_OPEN.length);
        this.inSay = true;
        continue;
      }
      let keep = 0;
      for (let k = Math.min(SAY_OPEN.length - 1, this.buf.length); k > 0; k--) {
        if (SAY_OPEN.startsWith(this.buf.slice(-k))) {
          keep = k;
          break;
        }
      }
      show += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      break;
    }
    if (said.length) this.said = [this.said, ...said].filter(Boolean).join(' ');
    return { show, said };
  }

  /** Text held back at the end of a turn (a lone "<", or an unclosed block, which is shown rather than lost). */
  flush(): string {
    const out = this.buf;
    this.buf = '';
    this.inSay = false;
    return out;
  }

  /** Everything spoken early in this run, joined. */
  get spoken(): string {
    return this.said;
  }
}

export interface VoiceTurn {
  /** v1.12: 'live' = a live spoken conversation: the reply itself is spoken as it streams. */
  mode?: 'live';
  lang?: string;
  confidence?: number;
  alternates?: string[];
}

/** Voice v2: extra instructions when the latest message was spoken, not typed. */
export function voiceInstructions(v: VoiceTurn): string {
  const conf = typeof v.confidence === 'number' && v.confidence >= 0 ? v.confidence : null;
  const alts = (v.alternates ?? []).filter((a) => typeof a === 'string' && a.trim()).slice(0, 3);
  return [
    `The user's latest message was spoken and turned into text by speech recognition${v.lang ? ` (${v.lang.replace(/[^\w-]/g, '')})` : ''}${conf !== null ? `, confidence ${conf.toFixed(2)}` : ''}. It may contain recognition mistakes.`,
    '- Users in the Philippines often mix Filipino and English (Taglish) in one sentence. Understand both, read misheard words by their likely meaning, and reply in the language mix the user used.',
    '- If a name, number, amount, date or the action itself is unclear and getting it wrong matters (anything that changes data or sends something), ask one short confirming question before acting. Otherwise just answer.',
    ...(alts.length ? [`- Other ways the recogniser heard it: ${untrustedInline(alts.join(' | '))}`] : []),
    `- Start your final reply with one short spoken sentence in ${SAY_OPEN}...${SAY_CLOSE} (at most about 25 words, plain words, no markdown), then the written answer. If you need to use tools first, you may start with a brief ${SAY_OPEN}...${SAY_CLOSE} saying what you are checking. When you used ${SAY_OPEN}, leave "speech" in the final meta block empty.`,
  ].join('\n');
}

/**
 * v1.12 live conversation (docs/30). The phone speaks the reply itself while it streams, clause by clause,
 * so the reply must be written to be heard. Anything only useful on screen (a list, a table, code, links)
 * goes after one line with ${'`'}<qline-screen>${'`'}: it is shown, never spoken.
 */
export const SCREEN_MARK = '<qline-screen>';

export function liveVoiceInstructions(v: VoiceTurn): string {
  const conf = typeof v.confidence === 'number' && v.confidence >= 0 ? v.confidence : null;
  const alts = (v.alternates ?? []).filter((a) => typeof a === 'string' && a.trim()).slice(0, 3);
  return [
    `This is a live spoken conversation. The user's latest message came from speech recognition${v.lang ? ` (${v.lang.replace(/[^\w-]/g, '')})` : ''}${conf !== null ? `, confidence ${conf.toFixed(2)}` : ''} and may contain recognition mistakes. Your reply is read aloud word for word while you write it.`,
    '- Talk like a capable person on a call: plain spoken sentences, contractions, no markdown, bullets, tables, headings, emojis, links or ids. Say numbers, dates and amounts the way you would say them aloud.',
    '- Your first sentence is short and useful on its own, so speech can start at once. Then add only what helps; usually one to four sentences in total, longer only when asked.',
    `- If something is only useful to read (a list of more than three items, a table, code, an address or a link), say a short summary, then write a line with only ${SCREEN_MARK} and put the details after it. Everything after ${SCREEN_MARK} is shown on screen and never spoken. Never put ${SCREEN_MARK} before the spoken part.`,
    '- Before using a tool, say a few words first (for example "Let me check your calendar."), then call it.',
    '- Users in the Philippines often mix Filipino and English (Taglish). Understand both and reply in the mix the user used.',
    '- If a name, number, amount, date or the action itself is unclear and getting it wrong matters (anything that changes data or sends something), ask one short question before acting. Do not guess names or numbers.',
    '- A reply of yours marked as interrupted was cut off: the user heard only the part quoted. Do not repeat it unless asked; answer what they said next.',
    `- Leave "speech" in the final meta block empty.`,
    ...(alts.length ? [`- Other ways the recogniser heard it: ${untrustedInline(alts.join(' | '))}`] : []),
  ].join('\n');
}

/**
 * v1.12: splits a live reply into the spoken part and the on-screen details. Text before the first
 * ${'`'}<qline-screen>${'`'} line is spoken; the marker is never shown; a partial marker at the end of a chunk is held back.
 */
export class ScreenFilter {
  private buf = '';
  private screen = false;

  /** Returns the parts of [chunk] that are ready, each marked spoken or on-screen only. */
  push(chunk: string): { text: string; say: boolean }[] {
    if (this.screen) return chunk ? [{ text: chunk, say: false }] : [];
    this.buf += chunk;
    const at = this.buf.indexOf(SCREEN_MARK);
    if (at >= 0) {
      const spoken = this.buf.slice(0, at).replace(/\s+$/, '');
      const rest = this.buf.slice(at + SCREEN_MARK.length).replace(/^[ \t]*\n?/, '');
      this.buf = '';
      this.screen = true;
      return [...(spoken ? [{ text: spoken, say: true }] : []), { text: `\n\n${rest}`, say: false }];
    }
    let keep = 0;
    for (let k = Math.min(SCREEN_MARK.length - 1, this.buf.length); k > 0; k--) {
      if (SCREEN_MARK.startsWith(this.buf.slice(-k))) {
        keep = k;
        break;
      }
    }
    const out = this.buf.slice(0, this.buf.length - keep);
    this.buf = this.buf.slice(this.buf.length - keep);
    return out ? [{ text: out, say: true }] : [];
  }

  /** Held-back text at the end of a turn (a lone "<"), still spoken. */
  flush(): { text: string; say: boolean }[] {
    const out = this.buf;
    this.buf = '';
    return out ? [{ text: out, say: !this.screen }] : [];
  }

  get onScreen(): boolean {
    return this.screen;
  }
}

const untrustedInline = (s: string) => JSON.stringify(s.replace(/[<>]/g, '').slice(0, 300));

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
