import { Inject, Injectable } from "@nestjs/common";
import { type ActionBatchStatus, type AssistantResponseMode, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service.js";
import { BusinessesRepository } from "./business.repositories.js";

type CreateActionBatchInput = {
  businessId: string;
  actorUserId: string;
  assistantSessionId?: string;
  voiceCommandId?: string;
  approvedTranscript?: string;
  proposedPlan?: Prisma.InputJsonValue;
  finalSummary?: string;
  spokenSummary?: string;
  status?: ActionBatchStatus;
  undoEligibleUntil?: Date;
};

@Injectable()
export class ActionBatchesRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateActionBatchInput) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.actionBatch.create({
      data: {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        assistantSessionId: input.assistantSessionId,
        voiceCommandId: input.voiceCommandId,
        approvedTranscript: input.approvedTranscript,
        proposedPlan: input.proposedPlan,
        finalSummary: input.finalSummary ?? "",
        spokenSummary: input.spokenSummary,
        status: input.status ?? "WAITING",
        undoEligibleUntil: input.undoEligibleUntil
      }
    });
  }

  async findByBusinessAndId(businessId: string, actionBatchId: string) {
    return this.prisma.actionBatch.findFirst({
      where: { id: actionBatchId, businessId },
      include: {
        steps: { orderBy: { createdAt: "asc" } },
        mutations: { orderBy: { sequence: "asc" } }
      }
    });
  }

  async findByVoiceCommandId(businessId: string, voiceCommandId: string) {
    return this.prisma.actionBatch.findFirst({
      where: { businessId, voiceCommandId },
      orderBy: { createdAt: "desc" }
    });
  }

  async listRecent(businessId: string, limit = 20) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.actionBatch.findMany({
      where: { businessId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(limit, 1), 100)
    });
  }
}

@Injectable()
export class UserPreferencesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getOrCreate(userId: string) {
    return this.prisma.userPreference.upsert({
      where: { userId },
      create: { userId },
      update: {}
    });
  }

  async updateAssistantResponseMode(userId: string, assistantResponseMode: AssistantResponseMode) {
    return this.prisma.userPreference.upsert({
      where: { userId },
      create: { userId, assistantResponseMode },
      update: { assistantResponseMode }
    });
  }
}
