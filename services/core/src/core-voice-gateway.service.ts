import { Inject, Injectable } from "@nestjs/common";
import { CoreAiInternalClient, CoreVoiceInternalClient } from "./core-internal-clients.service.js";

@Injectable()
export class CoreVoiceGatewayService {
  constructor(
    @Inject(CoreVoiceInternalClient) private readonly voiceClient: CoreVoiceInternalClient,
    @Inject(CoreAiInternalClient) private readonly aiClient: CoreAiInternalClient
  ) {}

  async transcribeOwnerCommandAudio(input: {
    audio: Buffer;
    contentType: string;
    filename: string;
    languageCode: string;
  }): Promise<{ provider: string; model?: string; languageCode: string; transcript: string; confidence: number }> {
    return this.voiceClient.transcribeOwnerCommandAudio(input);
  }

  async parseOwnerCommandIntent(input: { transcript: string; businessId: string; userId: string; idempotencyKey: string }) {
    return this.aiClient.parseOwnerCommandIntent(input);
  }
}
