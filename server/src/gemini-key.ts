import { GoogleGenAI, type Session, type LiveServerMessage, Modality } from '@google/genai';
import { LIVE_TRANSLATE_MODEL } from './gemini-bridge.js';

export interface GeminiKeyValidationResult {
  ok: boolean;
  reason: 'ok' | 'invalid' | 'timeout' | 'unavailable';
  message: string;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function classifyFailure(message: string): GeminiKeyValidationResult {
  const lower = message.toLowerCase();
  if (
    lower.includes('api key') ||
    lower.includes('apikey') ||
    lower.includes('permission') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('401') ||
    lower.includes('403')
  ) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'Gemini API key could not be validated for Live Translate.',
    };
  }
  return {
    ok: false,
    reason: 'unavailable',
    message: 'Gemini validation failed. Try again in a minute.',
  };
}

export async function validateGeminiLiveKey(
  apiKey: string,
  targetLanguageCode: string,
  echoTargetLanguage: boolean,
  timeoutMs = 8_000
): Promise<GeminiKeyValidationResult> {
  const ai = new GoogleGenAI({ apiKey });
  let session: Session | null = null;
  let lastError = '';

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: GeminiKeyValidationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        session?.close();
      } catch {
        /* validation cleanup best effort */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason: 'timeout',
        message: 'Gemini validation timed out. Try again in a minute.',
      });
    }, timeoutMs);
    timer.unref?.();

    void ai.live
      .connect({
        model: LIVE_TRANSLATE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: {
            targetLanguageCode,
            echoTargetLanguage,
          },
        },
        callbacks: {
          onmessage: (msg: LiveServerMessage) => {
            if ((msg as unknown as { setupComplete?: unknown }).setupComplete) {
              finish({ ok: true, reason: 'ok', message: 'ok' });
            }
          },
          onerror: (err: ErrorEvent) => {
            lastError = err?.message || 'Gemini validation socket error';
          },
          onclose: (event?: CloseEvent) => {
            if (settled) return;
            const reason = event?.reason || lastError || `Gemini validation closed with code ${event?.code ?? 'n/a'}`;
            finish(classifyFailure(reason));
          },
        },
      })
      .then((nextSession) => {
        session = nextSession;
        if (settled) {
          try {
            nextSession.close();
          } catch {
            /* validation cleanup best effort */
          }
        }
      })
      .catch((err) => {
        finish(classifyFailure(describeError(err)));
      });
  });
}
