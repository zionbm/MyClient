import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service.js";
import { BusinessesRepository } from "./business.repositories.js";
import { createdAtCursorWhere, paginationTake, type CreateAiPendingActionInput, type CreateNotificationInput, type PaginationInput, type RegisterDeviceTokenInput, type ResolveAiPendingActionInput, type UpdateAiPendingActionInput, type UpdateNotificationInput } from "./repository.shared.js";

@Injectable()
export class NotificationsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateNotificationInput) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.notification.create({
      data: {
        businessId: input.businessId,
        reminderId: input.reminderId,
        itemType: input.itemType,
        itemId: input.itemId,
        title: input.title,
        body: input.body,
        payload: input.payload
      }
    });
  }

  async listByBusiness(businessId: string, pagination?: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.notification.findMany({
      where: {
        businessId,
        ...createdAtCursorWhere(pagination?.cursor)
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
    });
  }

  async listByBusinessAndStatus(businessId: string, status?: string, pagination?: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.notification.findMany({
      where: {
        businessId,
        status: status as "PENDING" | "SENT" | "FAILED" | "READ" | undefined,
        ...createdAtCursorWhere(pagination?.cursor)
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
    });
  }

  async updateStatus(input: UpdateNotificationInput) {
    const existing = await this.prisma.notification.findFirst({
      where: {
        businessId: input.businessId,
        id: input.notificationId
      }
    });
    if (!existing) {
      return null;
    }

    const now = new Date();
    return this.prisma.notification.update({
      where: { id: existing.id },
      data: {
        status: input.status,
        readAt: input.status === "READ" ? now : undefined,
        sentAt: input.status === "SENT" ? now : undefined,
        failedAt: input.status === "FAILED" ? now : undefined,
        failureReason: input.status === "FAILED" ? input.failureReason ?? "Unknown failure" : undefined
      }
    });
  }

  async findByBusinessAndId(businessId: string, notificationId: string) {
    return this.prisma.notification.findFirst({
      where: {
        businessId,
        id: notificationId
      }
    });
  }

  async markAllRead(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.notification.updateMany({
      where: {
        businessId,
        status: {
          not: "READ"
        }
      },
      data: {
        status: "READ",
        readAt: new Date()
      }
    });
  }
}

@Injectable()
export class DeviceTokensRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async register(input: RegisterDeviceTokenInput) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.deviceToken.upsert({
      where: { token: input.token },
      update: {
        businessId: input.businessId,
        userId: input.userId,
        platform: input.platform,
        appVersion: input.appVersion,
        status: "ACTIVE",
        lastSeenAt: new Date()
      },
      create: {
        businessId: input.businessId,
        userId: input.userId,
        token: input.token,
        platform: input.platform,
        appVersion: input.appVersion
      }
    });
  }

  async listActiveByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.deviceToken.findMany({
      where: {
        businessId,
        status: "ACTIVE"
      },
      orderBy: { lastSeenAt: "desc" }
    });
  }

  async deactivate(token: string) {
    return this.prisma.deviceToken.updateMany({
      where: { token },
      data: { status: "INACTIVE" }
    });
  }
}

@Injectable()
export class AiPendingActionsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateAiPendingActionInput) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.aiPendingAction.create({
      data: {
        businessId: input.businessId,
        userId: input.userId,
        actionType: input.actionType,
        source: input.source ?? "ai",
        confidence: input.confidence,
        reviewReason: input.reviewReason,
        payload: input.payload,
        missingFields: input.missingFields,
        status: "PENDING"
      }
    });
  }

  async listByBusinessAndStatus(businessId: string, status?: string, pagination?: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.aiPendingAction.findMany({
      where: {
        businessId,
        status,
        ...createdAtCursorWhere(pagination?.cursor)
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
    });
  }

  async findByBusinessAndId(businessId: string, aiPendingActionId: string) {
    return this.prisma.aiPendingAction.findFirst({
      where: {
        businessId,
        id: aiPendingActionId
      }
    });
  }

  async resolve(input: ResolveAiPendingActionInput) {
    const result = await this.prisma.aiPendingAction.updateMany({
      where: {
        businessId: input.businessId,
        id: input.aiPendingActionId,
        status: input.expectedStatus
      },
      data: {
        status: input.status,
        resolution: input.resolution === undefined ? undefined : input.resolution,
        resolvedAt: new Date()
      }
    });

    if (result.count !== 1) {
      return null;
    }

    return this.findByBusinessAndId(input.businessId, input.aiPendingActionId);
  }

  async claimForExecution(input: { businessId: string; aiPendingActionId: string; userId: string }) {
    const result = await this.prisma.aiPendingAction.updateMany({
      where: {
        businessId: input.businessId,
        id: input.aiPendingActionId,
        status: "PENDING"
      },
      data: {
        status: "EXECUTING",
        resolution: { executingBy: input.userId, startedAt: new Date().toISOString() }
      }
    });

    if (result.count !== 1) {
      return null;
    }

    return this.findByBusinessAndId(input.businessId, input.aiPendingActionId);
  }

  async releaseExecutionClaim(input: { businessId: string; aiPendingActionId: string; reason: string }) {
    return this.prisma.aiPendingAction.updateMany({
      where: {
        businessId: input.businessId,
        id: input.aiPendingActionId,
        status: "EXECUTING"
      },
      data: {
        status: "PENDING",
        resolution: { failedExecutionAttemptAt: new Date().toISOString(), reason: input.reason }
      }
    });
  }

  async update(input: UpdateAiPendingActionInput) {
    const existing = await this.findByBusinessAndId(input.businessId, input.aiPendingActionId);
    if (!existing) {
      return null;
    }
    if (existing.status !== "PENDING") {
      throw new BadRequestException("AI pending action is already resolved");
    }
    return this.prisma.aiPendingAction.update({
      where: { id: existing.id },
      data: {
        payload: input.payload,
        missingFields: input.missingFields,
        reviewReason: input.reviewReason
      }
    });
  }
}

