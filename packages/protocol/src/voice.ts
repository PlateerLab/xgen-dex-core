/**
 * Voice — STT (speech→text) and TTS (text→speech) over the XGEN backend proxy.
 *
 * The connector NEVER sees the audio provider's base_url/api_key: it sends only
 * text/audio + its Bearer token, and the backend resolves the secrets and calls
 * the real STT/TTS endpoint server-side. This mirrors PreferencesApi/AvatarsApi
 * (same `http` core, same read-modify pattern for the profile endpoint).
 *
 * Endpoints (xgen-core):
 *  - POST /api/audio/stt/transcribe  multipart(file, language?) → { text }
 *  - POST /api/audio/tts/speak       JSON {text, voice_id?, …}  → audio bytes
 *  - GET  /api/admin/user            → preferences.stt / preferences.tts (hints)
 */
import { HttpClient } from './client';
import type { VoiceConfig, SttPref, TtsPref, TtsSpeakOptions } from './types';

interface RawProfile {
  // preferences may arrive as a parsed object OR (defensively) a JSON string.
  user?: { preferences?: Record<string, unknown> | string | null } | null;
}

/** Pick a filename (backend infers the format from the extension/mime). */
function filenameFor(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('webm')) return 'audio.webm';
  if (m.includes('ogg')) return 'audio.ogg';
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'audio.m4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio.mp3';
  return 'audio.webm';
}

export class VoiceApi {
  constructor(private http: HttpClient) {}

  /** GET /api/admin/user → { stt: preferences.stt|null, tts: preferences.tts|null }.
   *  UI hints only — no secrets. THROWS when not yet authenticated (mirrors
   *  PreferencesApi.getAvatarConfig) so callers can retry rather than latch a
   *  false "voice off". */
  async getVoiceConfig(): Promise<VoiceConfig> {
    const res = await this.http.get<RawProfile>('/api/admin/user');
    if (!res || !res.user) {
      throw new Error('voice config: no authenticated profile');
    }
    let prefs: unknown = res.user.preferences ?? {};
    if (typeof prefs === 'string') {
      try {
        prefs = JSON.parse(prefs);
      } catch {
        prefs = {};
      }
    }
    const p = (prefs as Record<string, unknown> | null) ?? {};
    const stt = p.stt && typeof p.stt === 'object' ? (p.stt as SttPref) : null;
    const tts = p.tts && typeof p.tts === 'object' ? (p.tts as TtsPref) : null;
    return { stt, tts };
  }

  /** POST an audio clip → transcript text. Uses the caller's saved STT
   *  preference server-side unless `language` overrides it. */
  async transcribe(blob: Blob, language?: string): Promise<string> {
    const form = new FormData();
    form.append('file', blob, filenameFor(blob.type));
    if (language) form.append('language', language);
    const res = await this.http.upload<{ text?: string }>('/api/audio/stt/transcribe', form);
    return res?.text ?? '';
  }

  /** POST text → synthesized audio Blob. Uses the caller's active TTS profile
   *  server-side unless `opts` overrides it. */
  async speak(text: string, opts?: TtsSpeakOptions): Promise<Blob> {
    const { bytes, contentType } = await this.http.postBinary(
      '/api/audio/tts/speak',
      { text, ...(opts ?? {}) },
      // Synthesis can take a few seconds for longer replies.
      { timeoutMs: 60_000 },
    );
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Blob([buf], { type: contentType || 'audio/wav' });
  }
}
