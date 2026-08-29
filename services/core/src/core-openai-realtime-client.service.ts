import { BadRequestException, Injectable } from "@nestjs/common";
import { getEnv, log } from "@myclient/common";

@Injectable()
export class CoreOpenAiRealtimeClient {
  async createTranscriptionClientSecret(input: { model: string }) {
    const apiKey = getEnv("OPENAI_API_KEY", "");
    if (!apiKey) {
      throw new BadRequestException("OpenAI API key is not configured");
    }

    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 120 },
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              noise_reduction: { type: "near_field" },
              transcription: {
                model: input.model,
                language: "he",
                prompt: "עברית ישראלית. פקודות קצרות לניהול לקוחות, תזכורות, ביקורי בית, הצעות מחיר והערות לקוח."
              }
            }
          }
        }
      })
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      log("error", "openai realtime client secret failed", {
        status: response.status,
        error: json
      });
      throw new BadRequestException("לא הצלחנו להכין הקלטה קולית");
    }

    const value = typeof json.value === "string" ? json.value : "";
    const expiresAt = typeof json.expires_at === "number" ? json.expires_at : 0;
    if (!value || !expiresAt) {
      throw new BadRequestException("OpenAI realtime session response is invalid");
    }
    return { value, expiresAt, model: input.model };
  }
}
