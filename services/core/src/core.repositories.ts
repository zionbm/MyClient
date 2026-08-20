import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
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

type RegisterBusinessInput = {
  firebaseUid: string;
  email: string;
  displayName: string;
  businessName: string;
};

@Injectable()
export class BusinessesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findById(businessId: string) {
    return this.prisma.business.findUnique({
      where: { id: businessId }
    });
  }

  async requireBusiness(businessId: string) {
    const business = await this.findById(businessId);
    if (!business) {
      throw new NotFoundException("Business not found");
    }

    return business;
  }
}

@Injectable()
export class AuthRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async registerBusiness(input: RegisterBusinessInput) {
    const existingUser = await this.prisma.user.findUnique({
      where: { firebaseUid: input.firebaseUid },
      include: { business: true }
    });

    if (existingUser) {
      return {
        created: false,
        business: existingUser.business,
        user: existingUser
      };
    }

    const emailUser = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true }
    });

    if (emailUser) {
      throw new ConflictException("Email is already registered");
    }

    return this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          name: input.businessName
        }
      });

      const user = await tx.user.create({
        data: {
          businessId: business.id,
          email: input.email,
          displayName: input.displayName,
          firebaseUid: input.firebaseUid
        }
      });

      await tx.auditEvent.createMany({
        data: [
          {
            businessId: business.id,
            actorType: "system",
            source: "auth",
            entityType: "business",
            entityId: business.id,
            action: "CREATE_BUSINESS",
            result: "SUCCESS",
            after: {
              name: business.name
            }
          },
          {
            businessId: business.id,
            actorType: "user",
            actorId: user.id,
            source: "auth",
            entityType: "user",
            entityId: user.id,
            action: "CREATE_OWNER_USER",
            result: "SUCCESS",
            after: {
              email: user.email,
              displayName: user.displayName,
              firebaseUid: user.firebaseUid
            }
          }
        ]
      });

      return {
        created: true,
        business,
        user
      };
    });
  }

  async getMe(firebaseUid: string) {
    return this.prisma.user.findUnique({
      where: { firebaseUid },
      include: { business: true }
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
    await this.businesses.requireBusiness(input.businessId);
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
    await this.businesses.requireBusiness(businessId);
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
    await this.businesses.requireBusiness(input.businessId);
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
    await this.businesses.requireBusiness(businessId);
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
    await this.businesses.requireBusiness(input.businessId);
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
    await this.businesses.requireBusiness(input.businessId);
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
    await this.businesses.requireBusiness(businessId);
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
    await this.businesses.requireBusiness(input.businessId);
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
