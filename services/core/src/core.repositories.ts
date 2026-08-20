import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service.js";

type CreateTaskInput = {
  businessId: string;
  customerId?: string;
  title: string;
  description?: string;
  priority?: "NORMAL" | "URGENT";
  dueAt?: Date;
  source: string;
  sourceRef?: string;
  idempotencyKey?: string;
};

type UpdateTaskInput = {
  businessId: string;
  taskId: string;
  customerId?: string;
  title?: string;
  description?: string;
  priority?: "NORMAL" | "URGENT";
  dueAt?: Date | null;
  status?: "OPEN" | "COMPLETED" | "CANCELLED";
};

type CreateCustomerInput = {
  businessId: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
};

type UpdateCustomerInput = {
  businessId: string;
  customerId: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
};

type CreateCustomerNoteInput = {
  businessId: string;
  customerId: string;
  text: string;
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
    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }

    return this.prisma.task.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        priority: input.priority ?? "NORMAL",
        dueAt: input.dueAt,
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

  async findByBusinessAndId(businessId: string, taskId: string) {
    return this.prisma.task.findFirst({
      where: {
        businessId,
        id: taskId
      }
    });
  }

  async update(input: UpdateTaskInput) {
    const existing = await this.findByBusinessAndId(input.businessId, input.taskId);
    if (!existing) {
      return null;
    }

    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }

    return this.prisma.task.update({
      where: { id: existing.id },
      data: {
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        dueAt: input.dueAt,
        status: input.status
      }
    });
  }

  async complete(businessId: string, taskId: string) {
    const existing = await this.findByBusinessAndId(businessId, taskId);
    if (!existing) {
      return null;
    }

    return this.prisma.task.update({
      where: { id: existing.id },
      data: { status: "COMPLETED" }
    });
  }

  private async ensureCustomerBelongsToBusiness(businessId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: {
        businessId,
        id: customerId
      },
      select: { id: true }
    });

    if (!customer) {
      throw new NotFoundException("Customer not found");
    }
  }
}

@Injectable()
export class CustomersRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateCustomerInput) {
    await this.businesses.ensureBusiness(input.businessId);
    return this.prisma.customer.create({
      data: {
        businessId: input.businessId,
        name: input.name,
        phone: input.phone,
        email: input.email,
        address: input.address
      }
    });
  }

  async listByBusiness(businessId: string) {
    return this.prisma.customer.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" }
    });
  }

  async findByBusinessAndId(businessId: string, customerId: string) {
    return this.prisma.customer.findFirst({
      where: {
        businessId,
        id: customerId
      }
    });
  }

  async update(input: UpdateCustomerInput) {
    const existing = await this.findByBusinessAndId(input.businessId, input.customerId);
    if (!existing) {
      return null;
    }

    return this.prisma.customer.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        phone: input.phone,
        email: input.email,
        address: input.address
      }
    });
  }
}

@Injectable()
export class CustomerNotesRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateCustomerNoteInput) {
    await this.businesses.ensureBusiness(input.businessId);
    const customer = await this.prisma.customer.findFirst({
      where: {
        businessId: input.businessId,
        id: input.customerId
      },
      select: { id: true }
    });

    if (!customer) {
      return null;
    }

    return this.prisma.customerNote.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        text: input.text
      }
    });
  }

  async listByCustomer(businessId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: {
        businessId,
        id: customerId
      },
      select: { id: true }
    });

    if (!customer) {
      return null;
    }

    return this.prisma.customerNote.findMany({
      where: {
        businessId,
        customerId
      },
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
