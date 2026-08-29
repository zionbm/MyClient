import { BadRequestException, HttpException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { getEnv } from "@myclient/common";
import {
  OwnerVoiceCommandHeadersSchema,
  OwnerVoiceCommandTranscriptSchema
} from "@myclient/contracts";
import {
  AuditRepository,
  BusinessSettingsRepository,
  OwnerVoiceCommandsRepository
} from "./core.repositories.js";
import { CoreAccessService } from "./core-access.service.js";
import { CoreOpenAiRealtimeClient } from "./core-openai-realtime-client.service.js";
import { CoreVoiceActionsService } from "./core-voice-actions.service.js";
import { CoreVoiceGatewayService } from "./core-voice-gateway.service.js";
import { CoreVoiceResultPresenter } from "./core-voice-result.presenter.js";
import {
  headerValue,
  paginatedResponse,
  paginationFromQuery,
  requireAudioBody,
  type RequestHeaders
} from "./core-utils.js";

@Injectable()
export class CoreVoiceCommandsApplicationService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreVoiceGatewayService) private readonly voiceGateway: CoreVoiceGatewayService,
    @Inject(CoreVoiceResultPresenter) private readonly voiceResultPresenter: CoreVoiceResultPresenter,
    @Inject(CoreVoiceActionsService) private readonly voiceActions: CoreVoiceActionsService,
    @Inject(CoreOpenAiRealtimeClient) private readonly realtimeClient: CoreOpenAiRealtimeClient,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(OwnerVoiceCommandsRepository) private readonly ownerVoiceCommands: OwnerVoiceCommandsRepository
  ) {}

  async listOwnerVoiceCommands(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.ownerVoiceCommands.listByBusiness(businessId, pagination), pagination.limit);
    return { voiceCommands: page.items, pageInfo: page.pageInfo };
  }

  async createOwnerVoiceRealtimeSession(headers: RequestHeaders, businessId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    const model = getEnv("OPENAI_REALTIME_TRANSCRIPTION_MODEL", "gpt-live-transcribe");
    return this.realtimeClient.createTranscriptionClientSecret({ model });
  }

  async createOwnerVoiceCommandFromTranscript(
    headers: RequestHeaders,
    businessId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const commandHeaders = OwnerVoiceCommandHeadersSchema.parse({
      idempotencyKey: headerValue(headers, "x-idempotency-key"),
      languageCode: headerValue(headers, "x-language-code") ?? "he-IL"
    });
    const transcriptBody = OwnerVoiceCommandTranscriptSchema.parse(body);
    const existing = await this.ownerVoiceCommands.findByBusinessAndIdempotencyKey(businessId, commandHeaders.idempotencyKey);
    if (existing) {
      return {
        duplicate: true,
        voiceCommand: existing,
        execution: existing.executionResult,
        voiceResult: this.voiceResultPresenter.fromStoredCommand(existing)
      };
    }

    let voiceCommand = await this.ownerVoiceCommands.create({
      businessId,
      userId: user.id,
      languageCode: transcriptBody.languageCode,
      idempotencyKey: commandHeaders.idempotencyKey
    });

    try {
      if (this.voiceResultPresenter.isInvalidTranscript(transcriptBody.transcript)) {
        throw new BadRequestException("לא זוהה דיבור ברור בהקלטה. נסה להקליט שוב קרוב יותר למיקרופון.");
      }
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        transcript: transcriptBody.transcript,
        sttProvider: transcriptBody.sttProvider,
        sttConfidence: transcriptBody.sttConfidence ?? undefined,
        executionStatus: "TRANSCRIBED"
      });

      const intent = await this.voiceGateway.parseOwnerCommandIntent({
        transcript: transcriptBody.transcript,
        businessId,
        userId: user.id,
        idempotencyKey: commandHeaders.idempotencyKey
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        llmProvider: intent.provider,
        llmAction: { actions: intent.actions } as Prisma.InputJsonValue,
        executionStatus: "PARSED"
      });

      const execution = await this.voiceActions.createPendingActionsFromVoiceCommand({
        businessId,
        userId: user.id,
        transcript: transcriptBody.transcript,
        actions: intent.actions
      });
      const settings = await this.settings.getByBusiness(businessId);
      const voiceResult = this.voiceResultPresenter.buildResult({
        transcript: transcriptBody.transcript,
        execution,
        timeZone: settings.timezone
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        executionStatus: execution.status,
        executionResult: { ...execution, voiceResult } as Prisma.InputJsonValue
      });
      await this.audit.record({
        businessId,
        actorType: "user",
        actorId: user.id,
        source: "owner_voice_command",
        entityType: "owner_voice_command",
        entityId: voiceCommand.id,
        action: "EXECUTE_OWNER_VOICE_COMMAND",
        after: voiceCommand as Prisma.InputJsonValue
      });

      return {
        duplicate: false,
        voiceCommand,
        stt: {
          transcript: transcriptBody.transcript,
          provider: transcriptBody.sttProvider,
          confidence: transcriptBody.sttConfidence ?? null
        },
        llm: intent,
        execution,
        voiceResult
      };
    } catch (error) {
      return this.failVoiceCommand({
        businessId,
        userId: user.id,
        voiceCommand,
        error
      });
    }
  }

  async createOwnerVoiceCommandFromAudio(
    headers: RequestHeaders,
    businessId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const audio = requireAudioBody(body);
    const commandHeaders = OwnerVoiceCommandHeadersSchema.parse({
      idempotencyKey: headerValue(headers, "x-idempotency-key"),
      languageCode: headerValue(headers, "x-language-code") ?? "he-IL",
      filename: headerValue(headers, "x-audio-filename") ?? "owner-command.m4a"
    });
    const existing = await this.ownerVoiceCommands.findByBusinessAndIdempotencyKey(businessId, commandHeaders.idempotencyKey);
    if (existing) {
      return {
        duplicate: true,
        voiceCommand: existing,
        execution: existing.executionResult,
        voiceResult: this.voiceResultPresenter.fromStoredCommand(existing)
      };
    }

    let voiceCommand = await this.ownerVoiceCommands.create({
      businessId,
      userId: user.id,
      languageCode: commandHeaders.languageCode,
      idempotencyKey: commandHeaders.idempotencyKey
    });

    try {
      const stt = await this.voiceGateway.transcribeOwnerCommandAudio({
        audio,
        contentType: headerValue(headers, "content-type") ?? "audio/mp4",
        filename: commandHeaders.filename,
        languageCode: commandHeaders.languageCode
      });
      if (this.voiceResultPresenter.isInvalidTranscript(stt.transcript)) {
        throw new BadRequestException("לא זוהה דיבור ברור בהקלטה. נסה להקליט שוב קרוב יותר למיקרופון.");
      }
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        transcript: stt.transcript,
        sttProvider: stt.provider,
        sttConfidence: stt.confidence,
        executionStatus: "TRANSCRIBED"
      });

      const intent = await this.voiceGateway.parseOwnerCommandIntent({
        transcript: stt.transcript,
        businessId,
        userId: user.id,
        idempotencyKey: commandHeaders.idempotencyKey
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        llmProvider: intent.provider,
        llmAction: { actions: intent.actions } as Prisma.InputJsonValue,
        executionStatus: "PARSED"
      });

      const execution = await this.voiceActions.createPendingActionsFromVoiceCommand({
        businessId,
        userId: user.id,
        transcript: stt.transcript,
        actions: intent.actions
      });
      const settings = await this.settings.getByBusiness(businessId);
      const voiceResult = this.voiceResultPresenter.buildResult({
        transcript: stt.transcript,
        execution,
        timeZone: settings.timezone
      });
      voiceCommand = await this.ownerVoiceCommands.update({
        id: voiceCommand.id,
        executionStatus: execution.status,
        executionResult: { ...execution, voiceResult } as Prisma.InputJsonValue
      });
      await this.audit.record({
        businessId,
        actorType: "user",
        actorId: user.id,
        source: "owner_voice_command",
        entityType: "owner_voice_command",
        entityId: voiceCommand.id,
        action: "EXECUTE_OWNER_VOICE_COMMAND",
        after: voiceCommand as Prisma.InputJsonValue
      });

      return {
        duplicate: false,
        voiceCommand,
        stt,
        llm: intent,
        execution,
        voiceResult
      };
    } catch (error) {
      return this.failVoiceCommand({
        businessId,
        userId: user.id,
        voiceCommand,
        error
      });
    }
  }

  private async failVoiceCommand(input: {
    businessId: string;
    userId: string;
    voiceCommand: Awaited<ReturnType<OwnerVoiceCommandsRepository["create"]>>;
    error: unknown;
  }) {
    const response = input.error instanceof HttpException ? input.error.getResponse() : undefined;
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    const voiceResult = this.voiceResultPresenter.buildFailedResult({
      transcript: input.voiceCommand.transcript,
      message
    });
    const voiceCommand = await this.ownerVoiceCommands.update({
      id: input.voiceCommand.id,
      executionStatus: "FAILED",
      executionResult: {
        message,
        voiceResult,
        ...(typeof response === "object" && response !== null ? { details: response } : {})
      } as Prisma.InputJsonValue
    });
    await this.audit.record({
      businessId: input.businessId,
      actorType: "user",
      actorId: input.userId,
      source: "owner_voice_command",
      entityType: "owner_voice_command",
      entityId: voiceCommand.id,
      action: "FAIL_OWNER_VOICE_COMMAND",
      after: voiceCommand as Prisma.InputJsonValue,
      result: "FAILED"
    });
    return {
      duplicate: false,
      voiceCommand,
      execution: voiceCommand.executionResult,
      voiceResult
    };
  }
}
