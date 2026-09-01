import { BadRequestException, Injectable } from "@nestjs/common";
import { cloudRunServiceAuthHeaders, getEnv, getInternalApiSecret } from "@myclient/common";
import { AiActionBatchSchema, AiActionSchema, AssistantPlanSchema } from "@myclient/contracts";

@Injectable()
export class CoreVoiceInternalClient {
  async transcribeOwnerCommandAudio(input: {
    audio: Buffer;
    contentType: string;
    filename: string;
    languageCode: string;
  }): Promise<{ provider: string; model?: string; languageCode: string; transcript: string; confidence: number }> {
    const voiceBaseUrl = getEnv("VOICE_BASE_URL", "http://localhost:3002");
    const useMockStt = getEnv("MOCK_STT_PROVIDER", "false") === "true";
    const audioBody = input.audio.buffer.slice(input.audio.byteOffset, input.audio.byteOffset + input.audio.byteLength) as ArrayBuffer;
    const response = await fetch(`${voiceBaseUrl}${useMockStt ? "/stt/mock" : "/stt/openai"}`, {
      method: "POST",
      headers: {
        ...(await cloudRunServiceAuthHeaders(voiceBaseUrl)),
        "x-internal-secret": getInternalApiSecret(),
        ...(useMockStt ? { "content-type": "application/json" } : {
          "content-type": input.contentType,
          "x-audio-filename": input.filename,
          "x-language-code": input.languageCode
        })
      },
      body: useMockStt ? JSON.stringify({ languageCode: input.languageCode }) : audioBody
    });
    const result = (await response.json().catch(() => ({}))) as {
      provider?: string; model?: string; languageCode?: string; transcript?: string; confidence?: number;
    };
    if (!response.ok) {
      throw new BadRequestException({ message: `Voice STT failed with ${response.status}`, details: result });
    }
    if (!result.transcript) {
      throw new BadRequestException("Voice STT returned empty transcript");
    }
    return {
      provider: result.provider ?? "openai",
      model: result.model,
      languageCode: result.languageCode ?? input.languageCode,
      transcript: result.transcript,
      confidence: result.confidence ?? 1
    };
  }
}

@Injectable()
export class CoreAiInternalClient {
  async parseOwnerCommandIntent(input: { transcript: string; businessId: string; userId: string; idempotencyKey: string }) {
    const aiBaseUrl = getEnv("AI_BASE_URL", "http://localhost:3001");
    const response = await fetch(`${aiBaseUrl}/intent/parse`, {
      method: "POST",
      headers: {
        ...(await cloudRunServiceAuthHeaders(aiBaseUrl)),
        "content-type": "application/json",
        "x-internal-secret": getInternalApiSecret()
      },
      body: JSON.stringify({
        text: input.transcript,
        businessId: input.businessId,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey
      })
    });
    const result = (await response.json().catch(() => ({}))) as { provider?: string; action?: unknown; actions?: unknown };
    if (!response.ok) {
      throw new BadRequestException({ message: `AI intent parsing failed with ${response.status}`, details: result });
    }
    const actions = result.actions
      ? AiActionBatchSchema.parse({ actions: result.actions }).actions
      : [AiActionSchema.parse(result.action)];
    return { provider: result.provider ?? "openai", action: actions[0], actions };
  }

  async planV2AssistantCommand(input: { transcript: string; context: unknown }) {
    const aiBaseUrl = getEnv("AI_BASE_URL", "http://localhost:3001");
    const response = await fetch(`${aiBaseUrl}/v2/assistant/plan`, {
      method: "POST",
      headers: {
        ...(await cloudRunServiceAuthHeaders(aiBaseUrl)),
        "content-type": "application/json",
        "x-internal-secret": getInternalApiSecret()
      },
      body: JSON.stringify(input)
    });
    const result = (await response.json().catch(() => ({}))) as { provider?: string; plan?: unknown };
    if (!response.ok) {
      throw new BadRequestException({ message: `AI V2 planning failed with ${response.status}`, details: result });
    }
    return { provider: result.provider ?? "openai", plan: AssistantPlanSchema.parse(result.plan) };
  }

  async summarizeV2AssistantReceipt(input: { transcript: string; receipt: unknown }) {
    const aiBaseUrl = getEnv("AI_BASE_URL", "http://localhost:3001");
    const response = await fetch(`${aiBaseUrl}/v2/assistant/summarize`, {
      method: "POST",
      headers: { ...(await cloudRunServiceAuthHeaders(aiBaseUrl)), "content-type": "application/json", "x-internal-secret": getInternalApiSecret() },
      body: JSON.stringify(input)
    });
    const result = (await response.json().catch(() => ({}))) as { textSummary?: string; spokenSummary?: string };
    if (!response.ok || !result.textSummary || !result.spokenSummary) throw new BadRequestException("AI V2 summary failed");
    return result as { textSummary: string; spokenSummary: string };
  }
}
