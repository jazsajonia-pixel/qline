import { Hono } from 'hono';
import { z } from 'zod';
import { need, tx, type Env } from '../core/context';
import { ApiError } from '../core/errors';
import { body } from '../core/validate';
import { loadKey } from '../agent/models';

/**
 * Natural voices for Live AI using the organization's own provider keys:
 *  - Gemini TTS (has a free tier on the Gemini API; Google may use free-tier data to improve products)
 *  - OpenAI TTS (paid per use)
 * The phone's built-in voice stays the offline default. Audio comes back as WAV plus a loudness
 * envelope so the energy core can move with the actual speech.
 */
export const voiceRoutes = new Hono<Env>();

export const GEMINI_VOICES = [
  { id: 'Sulafat', label: 'Sulafat · warm' },
  { id: 'Achird', label: 'Achird · friendly' },
  { id: 'Kore', label: 'Kore · firm, clear' },
  { id: 'Aoede', label: 'Aoede · breezy' },
  { id: 'Callirrhoe', label: 'Callirrhoe · easy-going' },
  { id: 'Puck', label: 'Puck · upbeat' },
  { id: 'Charon', label: 'Charon · informative' },
  { id: 'Vindemiatrix', label: 'Vindemiatrix · gentle' },
  { id: 'Orus', label: 'Orus · steady (male)' },
  { id: 'Fenrir', label: 'Fenrir · energetic (male)' },
];
export const OPENAI_VOICES = ['marin', 'cedar', 'coral', 'sage', 'alloy', 'ash', 'ballad', 'echo', 'shimmer', 'verse'].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));

const GEMINI_TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts'];
let geminiModel: string | null = null;

function wav(pcm: Buffer, rate: number) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** RMS loudness per 50 ms window, normalised 0..1. */
export function envelope(pcm: Buffer, rate: number, ms = 50) {
  const n = Math.floor(pcm.length / 2);
  const win = Math.max(1, Math.floor((rate * ms) / 1000));
  const out: number[] = [];
  let peak = 1e-6;
  for (let i = 0; i < n; i += win) {
    let s = 0;
    const end = Math.min(n, i + win);
    for (let j = i; j < end; j++) {
      const v = pcm.readInt16LE(j * 2) / 32768;
      s += v * v;
    }
    const r = Math.sqrt(s / Math.max(1, end - i));
    out.push(r);
    if (r > peak) peak = r;
  }
  return out.map((v) => Math.round(Math.min(1, v / peak) * 100) / 100);
}

async function gemini(key: string, text: string, voice: string) {
  const models = geminiModel ? [geminiModel] : GEMINI_TTS_MODELS;
  let last: { status: number; msg: string } = { status: 500, msg: 'No TTS model available' };
  for (const m of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Say this naturally, in a warm, relaxed, conversational way, like a helpful colleague talking to a friend:\n${text}` }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok) {
      const part = j.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
      if (!part) throw new ApiError(502, 'VOICE_EMPTY', 'Gemini returned no audio');
      geminiModel = m;
      const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? 24000);
      return { pcm: Buffer.from(part.inlineData.data, 'base64'), rate };
    }
    last = { status: r.status, msg: j.error?.message ?? `HTTP ${r.status}` };
    if (r.status !== 404 && r.status !== 400) break; // only try the next model when this one doesn't exist
  }
  throw upstreamError('Gemini', last.status, last.msg);
}

async function openai(key: string, text: string, voice: string) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm', instructions: 'Warm, natural and conversational, like a helpful colleague.' }),
  });
  if (!r.ok) {
    const j: any = await r.json().catch(() => ({}));
    throw upstreamError('OpenAI', r.status, j.error?.message ?? `HTTP ${r.status}`);
  }
  return { pcm: Buffer.from(await r.arrayBuffer()), rate: 24000 };
}

function upstreamError(name: string, status: number, msg: string) {
  if (status === 429) return new ApiError(429, 'VOICE_RATE_LIMITED', `${name} voice limit reached`, `${msg.slice(0, 200)} Qline will use the phone voice for now.`);
  if (status === 401 || status === 403) return new ApiError(400, 'VOICE_KEY_REJECTED', `${name} rejected the key for voice`, msg.slice(0, 200));
  return new ApiError(502, 'VOICE_PROVIDER_ERROR', `${name} voice failed`, msg.slice(0, 200));
}

voiceRoutes.get('/voice/options', async (c) => {
  const t = need(c, 'agents.use');
  const [g, o] = await tx(t, async (q) => [await loadKey(q, t.orgId, 'google'), await loadKey(q, t.orgId, 'openai')]);
  return c.json({
    engines: [
      { id: 'device', name: 'Phone voice', available: true, cost: 'Free, works offline', voices: [] },
      { id: 'gemini', name: 'Gemini natural voice', available: !!g, cost: 'Free tier on your Gemini key (rate limited; Google may use free-tier data to improve its products)', voices: GEMINI_VOICES },
      { id: 'openai', name: 'OpenAI natural voice', available: !!o, cost: 'Paid per use on your OpenAI key', voices: OPENAI_VOICES },
    ],
  });
});

voiceRoutes.post('/voice/speak', async (c) => {
  const t = need(c, 'agents.use');
  const input = await body(c, z.object({ text: z.string().trim().min(1).max(1500), engine: z.enum(['gemini', 'openai']), voice: z.string().max(40).optional() }));
  const key = await tx(t, (q) => loadKey(q, t.orgId, input.engine === 'gemini' ? 'google' : 'openai'));
  if (!key) throw new ApiError(409, 'VOICE_NOT_CONFIGURED', 'No key for this voice', `Add a ${input.engine === 'gemini' ? 'Google Gemini' : 'OpenAI'} key in Settings → AI providers.`);
  const voice = input.voice ?? (input.engine === 'gemini' ? 'Sulafat' : 'marin');
  const { pcm, rate } = input.engine === 'gemini' ? await gemini(key, input.text, voice) : await openai(key, input.text, voice);
  return c.json({ audio: wav(pcm, rate).toString('base64'), mime: 'audio/wav', sampleRate: rate, durationMs: Math.round((pcm.length / 2 / rate) * 1000), envelopeMs: 50, envelope: envelope(pcm, rate) });
});
