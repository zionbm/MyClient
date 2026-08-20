import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service.js";

type CreateTaskInput = {
  businessId: string;
  customerId?: string;
  title: string;
  description?: string;
  priority?: "NORMAL" | "URGENT";
  source: string;
  sourceRef?: string;
  idempotencyKey?: string;
};

type CreateNotificationInput = {
  businessId: string;
  taskId?: string;
  title: string;
  body: string;
  payload?: Prisma.InputJsonValue;
};

type CreatePendingActionInput = {
  businessId: string;
  userId?: string;
  actionType: string;
  payload: Prisma.InputJsonValue;
  missingFields: string[];
};

@Injectable()
export class BusinessesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async ensureBusiness(businessId: string) {
    return this.prisma.business.upsert({
      where: { id: businessId },
      update: {},
      create: {
        id: businessId,
        name: `Mock Business ${businessId}`
      }
    });
  }
}

@Injectable()
export class TasksRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async findByIdempotencyKey(businessId: string, idempotencyKey: string) {
    return this.prisma.task.findFirst({
      where: {
        businessId,
        idempotencyKey
      }
    });
  }

  async create(input: CreateTaskInput) {
    await this.businesses.ensureBusiness(input.businessId);
    return this.prisma.task.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        priority: input.priority ?? "NORMAL",
        source: input.source,
        sourceRef: input.sourceRef,
        idempotencyKey: input.idempotencyKey
      }
    });
  }

  async listByBusiness(businessId: string) {
    return this.prisma.task.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" }
    });
  }
}

@Injectable()
export class NotificationsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateNotificationInput) {
    await this.businesses.ensureBusiness(input.businessId);
    return this.prisma.notification.create({
      data: {
        businessId: input.businessId,
        taskId: input.taskId,
        title: input.title,
        body: input.body,
        payload: input.payload
      }
    });
  }

  async listByBusiness(businessId: string) {
    return this.prisma.notification.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" }
    });
  }
}

@Injectable()
export class PendingActionsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreatePendingActionInput) {
    await this.businesses.ensureBusiness(input.businessId);
    return this.prisma.pendingAction.create({
      data: {
        businessId: input.businessId,
        userId: input.userId,
        actionType: input.actionType,
        payload: input.payload,
        missingFields: input.missingFields
      }
    });
  }
}
