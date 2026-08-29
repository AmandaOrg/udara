/**
 * Deepgram listen (STT) for inbound WhatsApp voice notes.
 *
 * REST, not the SDK: POST https://api.deepgram.com/v1/listen
 * Auth is `Authorization: Token <key>` (not Bearer). WhatsApp OGG/Opus
 * works as-is; Deepgram sniffs magic bytes.
 */

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
const STT_TIMEOUT_MS = 20_000;
const STT_MAX_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_MAX_CHARS = 8_000;

export interface TranscribeResult {
  ok: boolean;
  text: string;
  language: string | null;
  error?: string;
}

interface DeepgramListenResponse {
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
      }>;
    }>;
  };
}

@Injectable()
export class DeepgramService {
  private readonly logger = new Logger(DeepgramService.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  private apiKey(): string {
    return this.config.get<string>("DEEPGRAM_API_KEY", "").trim();
  }

  private sttModel(): string {
    return (
      this.config.get<string>("DEEPGRAM_STT_MODEL", "nova-3").trim() || "nova-3"
    );
  }

  async transcribe(
    audio: Buffer,
    mimeType?: string,
  ): Promise<TranscribeResult> {
    const key = this.apiKey();
    if (!key) {
      return { ok: false, text: "", language: null, error: "not_configured" };
    }
    if (!audio.length) {
      return { ok: false, text: "", language: null, error: "empty_audio" };
    }
    if (audio.length > STT_MAX_BYTES) {
      return { ok: false, text: "", language: null, error: "too_large" };
    }

    const params = new URLSearchParams({
      model: this.sttModel(),
      smart_format: "true",
      detect_language: "true",
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
    try {
      const res = await fetch(`${DEEPGRAM_LISTEN_URL}?${params.toString()}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${key}`,
          "Content-Type": mimeType?.trim() || "application/octet-stream",
        },
        body: new Uint8Array(audio),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`Deepgram listen failed: HTTP ${res.status}`);
        return {
          ok: false,
          text: "",
          language: null,
          error: `http_${res.status}`,
        };
      }
      const json = (await res.json()) as DeepgramListenResponse;
      const alt = json.results?.channels?.[0]?.alternatives?.[0];
      const raw = (alt?.transcript ?? "").trim();
      const text = raw.slice(0, TRANSCRIPT_MAX_CHARS);
      if (!text) {
        return {
          ok: false,
          text: "",
          language: null,
          error: "empty_transcript",
        };
      }
      return {
        ok: true,
        text,
        language: json.results?.channels?.[0]?.detected_language ?? null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.name : "error";
      this.logger.warn(`Deepgram listen error: ${message}`);
      return { ok: false, text: "", language: null, error: "listen_failed" };
    } finally {
      clearTimeout(timer);
    }
  }
}
