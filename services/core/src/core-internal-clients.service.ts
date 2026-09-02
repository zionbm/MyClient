import { BadRequestException, Injectable } from "@nestjs/common";
import { cloudRunServiceAuthHeaders, getEnv, getInternalApiSecret } from "@myclient/common";
import { AssistantPlanSchema } from "@myclient/contracts";

@Injectable()
export class CoreVoiceInternalClient {
  async synthesizeAssistantSummary(text: string) {
    const voiceBaseUrl = getEnv("VOICE_BASE_URL", "http://localhost:3002");
    const response = await fetch(`${voiceBaseUrl}/tts`, {
      method: "POST",
      headers: { ...(await cloudRunServiceAuthHeaders(voiceBaseUrl)), "content-type": "application/json", "x-internal-secret": getInternalApiSecret() },
      body: JSON.stringify({ text })
    });
    const result = (await response.json().catch(() => ({}))) as { provider?: string; audioObjectUri?: string; audioBase64?: string; contentType?: string; text?: string };
    if (!response.ok) throw new BadRequestException("Voice TTS failed");
    return result;
  }

}

@Injectable()
export class CoreAiInternalClient {
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

}
