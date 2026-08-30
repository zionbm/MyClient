import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { stableIdempotencyKey } from "@myclient/common";
import {
  AiPendingActionListQuerySchema,
  ApproveAiPendingActionSchema,
  UpdateAiPendingActionSchema
} from "@myclient/contracts";
import {
  AiPendingActionsRepository,
  AuditRepository
} from "./core.repositories.js";
import { CoreAccessService } from "./core-access.service.js";
import { CoreActionExecutionService } from "./core-action-execution.service.js";
import { CoreVoiceActionsService } from "./core-voice-actions.service.js";
import {
  paginatedResponse,
  paginationFromParsedQuery,
  paginationFromQuery,
  type RequestHeaders
} from "./core-utils.js";

@Injectable()
export class CoreAiPendingActionsApplicationService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreActionExecutionService) private readonly actionExecution: CoreActionExecutionService,
    @Inject(CoreVoiceActionsService) private readonly voiceActions: CoreVoiceActionsService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(AiPendingActionsRepository) private readonly aiPendingActions: AiPendingActionsRepository
  ) {}

  async listAiPendingActions(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const command = AiPendingActionListQuerySchema.parse(query);
    const pagination = paginationFromParsedQuery(command);
    const [items, totalCount] = await Promise.all([
      this.aiPendingActions.listByBusinessAndStatus(businessId, command.status, pagination),
      this.aiPendingActions.countByBusinessAndStatus(businessId, command.status)
    ]);
    const page = paginatedResponse(items, pagination.limit);
    return { aiPendingActions: page.items, pageInfo: page.pageInfo, totalCount };
  }

  async updateAiPendingAction(
    headers: RequestHeaders,
    businessId: string,
    aiPendingActionId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateAiPendingActionSchema.parse(body);
    const aiPendingAction = await this.aiPendingActions.update({
      businessId,
      aiPendingActionId,
      payload: command.payload as Prisma.InputJsonValue | undefined,
      missingFields: command.missingFields,
      reviewReason: command.reviewReason
    });
    if (!aiPendingAction) {
      throw new NotFoundException("AI pending action not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "ai_pending_action",
      entityId: aiPendingAction.id,
      action: "UPDATE_AI_PENDING_ACTION",
      after: aiPendingAction as Prisma.InputJsonValue
    });
    return { aiPendingAction };
  }

  async rejectAiPendingAction(
    headers: RequestHeaders,
    businessId: string,
    aiPendingActionId: string
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const existing = await this.aiPendingActions.findByBusinessAndId(businessId, aiPendingActionId);
    if (!existing) {
      throw new NotFoundException("AI pending action not found");
    }
    if (existing.status !== "PENDING") {
      throw new BadRequestException("AI pending action is already resolved");
    }
    const aiPendingAction = await this.aiPendingActions.resolve({
      businessId,
      aiPendingActionId,
      expectedStatus: "PENDING",
      status: "REJECTED",
      resolution: { rejectedBy: user.id }
    });
    if (!aiPendingAction) {
      throw new BadRequestException("AI pending action is already resolved");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "ai_pending_action",
      entityId: aiPendingAction.id,
      action: "REJECT_AI_PENDING_ACTION",
      after: aiPendingAction as Prisma.InputJsonValue
    });
    return { aiPendingAction };
  }

  async approveAiPendingAction(
    headers: RequestHeaders,
    businessId: string,
    aiPendingActionId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = ApproveAiPendingActionSchema.parse(body);
    const claimed = await this.aiPendingActions.claimForExecution({
      businessId,
      aiPendingActionId,
      userId: user.id
    });
    if (!claimed) {
      const existing = await this.aiPendingActions.findByBusinessAndId(businessId, aiPendingActionId);
      if (!existing) {
        throw new NotFoundException("AI pending action not found");
      }
      throw new BadRequestException("AI pending action is already resolved");
    }

    try {
      const payload = await this.voiceActions.preparePayloadForApproval({
        businessId,
        actionType: claimed.actionType,
        payload: {
          ...(claimed.payload as Record<string, unknown>),
          ...(command.payload ?? {})
        }
      });
      const execution = await this.actionExecution.execute({
        businessId,
        userId: user.id,
        actionType: claimed.actionType,
        payload,
        idempotencyKey: stableIdempotencyKey("ai_pending_action", claimed.id),
        resolveDueAt: (targetBusinessId, actionPayload) => this.voiceActions.resolveAiReminderDueAt(targetBusinessId, actionPayload)
      });
      const aiPendingAction = await this.aiPendingActions.resolve({
        businessId,
        aiPendingActionId,
        expectedStatus: "EXECUTING",
        status: "EXECUTED",
        resolution: {
          executedBy: user.id,
          execution
        } as Prisma.InputJsonValue
      });
      await this.audit.record({
        businessId,
        actorType: "user",
        actorId: user.id,
        source: "core",
        entityType: "ai_pending_action",
        entityId: aiPendingAction?.id,
        action: "APPROVE_AI_PENDING_ACTION",
        after: aiPendingAction as Prisma.InputJsonValue
      });
      return { aiPendingAction, execution };
    } catch (error) {
      await this.aiPendingActions.releaseExecutionClaim({
        businessId,
        aiPendingActionId,
        reason: error instanceof Error ? error.message : "Unknown approval error"
      });
      throw error;
    }
  }

  async listAuditEvents(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireBusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.audit.listByBusiness(businessId, pagination), pagination.limit);
    return { auditEvents: page.items, pageInfo: page.pageInfo };
  }
}
