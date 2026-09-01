import { Inject, Injectable } from "@nestjs/common";
import { type TaskStatus } from "@prisma/client";
import { PrismaService } from "../prisma.service.js";
import { BusinessesRepository } from "./business.repositories.js";
import { createdAtCursorWhere, paginationTake, type PaginationInput } from "./repository.shared.js";

@Injectable()
export class V2CustomersRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: {
    businessId: string;
    name: string;
    normalizedName: string;
    email?: string;
    generalNotes?: string;
  }) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.customer.create({ data: input });
  }

  async list(businessId: string, pagination: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.customer.findMany({
      where: {
        businessId,
        deletedAt: null,
        mergedIntoCustomerId: null,
        ...createdAtCursorWhere(pagination.cursor)
      },
      include: {
        customerPhones: { where: { deletedAt: null }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        serviceAddresses: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
    });
  }

  async findById(businessId: string, customerId: string) {
    return this.prisma.customer.findFirst({
      where: { id: customerId, businessId, deletedAt: null, mergedIntoCustomerId: null },
      include: {
        customerPhones: { where: { deletedAt: null }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        serviceAddresses: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
        tasks: { where: { deletedAt: null }, orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }] }
      }
    });
  }

  async update(input: {
    businessId: string;
    customerId: string;
    name?: string;
    normalizedName?: string;
    email?: string | null;
    generalNotes?: string | null;
    version?: number;
  }) {
    const updated = await this.prisma.customer.updateMany({
      where: {
        id: input.customerId,
        businessId: input.businessId,
        deletedAt: null,
        mergedIntoCustomerId: null,
        version: input.version
      },
      data: {
        name: input.name,
        normalizedName: input.normalizedName,
        email: input.email,
        generalNotes: input.generalNotes,
        version: { increment: 1 }
      }
    });
    return updated.count === 1 ? this.findById(input.businessId, input.customerId) : null;
  }
}

@Injectable()
export class V2CustomerPhonesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  findActiveByNormalizedPhone(businessId: string, normalizedPhone: string) {
    return this.prisma.customerPhone.findFirst({
      where: { businessId, normalizedPhone, deletedAt: null },
      include: { customer: true }
    });
  }

  async create(input: {
    businessId: string;
    customerId: string;
    rawPhone: string;
    normalizedPhone: string;
    label?: string;
    isPrimary?: boolean;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null }
      });
      if (!customer) return null;
      const activeCount = await tx.customerPhone.count({
        where: { businessId: input.businessId, customerId: input.customerId, deletedAt: null }
      });
      const isPrimary = input.isPrimary ?? activeCount === 0;
      if (isPrimary) {
        await tx.customerPhone.updateMany({
          where: { businessId: input.businessId, customerId: input.customerId, deletedAt: null },
          data: { isPrimary: false }
        });
      }
      return tx.customerPhone.create({
        data: { ...input, isPrimary }
      });
    });
  }

  async update(input: {
    businessId: string;
    customerId: string;
    phoneId: string;
    rawPhone?: string;
    normalizedPhone?: string;
    label?: string | null;
    isPrimary?: boolean;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.customerPhone.findFirst({
        where: { id: input.phoneId, businessId: input.businessId, customerId: input.customerId, deletedAt: null }
      });
      if (!existing) return null;
      if (input.isPrimary) {
        await tx.customerPhone.updateMany({
          where: { businessId: input.businessId, customerId: input.customerId, deletedAt: null },
          data: { isPrimary: false }
        });
      }
      return tx.customerPhone.update({
        where: { id: existing.id },
        data: {
          rawPhone: input.rawPhone,
          normalizedPhone: input.normalizedPhone,
          label: input.label,
          isPrimary: input.isPrimary
        }
      });
    });
  }

  async softDelete(input: { businessId: string; customerId: string; phoneId: string; deletedByUserId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.customerPhone.findFirst({
        where: { id: input.phoneId, businessId: input.businessId, customerId: input.customerId, deletedAt: null }
      });
      if (!existing) return null;
      const deleted = await tx.customerPhone.update({
        where: { id: existing.id },
        data: { deletedAt: new Date(), deletedByUserId: input.deletedByUserId, isPrimary: false }
      });
      if (existing.isPrimary) {
        const replacement = await tx.customerPhone.findFirst({
          where: { businessId: input.businessId, customerId: input.customerId, deletedAt: null },
          orderBy: { createdAt: "asc" }
        });
        if (replacement) {
          await tx.customerPhone.update({ where: { id: replacement.id }, data: { isPrimary: true } });
        }
      }
      return deleted;
    });
  }
}

@Injectable()
export class V2ServiceAddressesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: {
    businessId: string;
    customerId: string;
    label?: string;
    addressText: string;
    normalizedAddress: string;
  }) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: input.customerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null }
    });
    return customer ? this.prisma.serviceAddress.create({ data: input }) : null;
  }

  async update(input: {
    businessId: string;
    customerId: string;
    addressId: string;
    label?: string | null;
    addressText?: string;
    normalizedAddress?: string;
  }) {
    const existing = await this.prisma.serviceAddress.findFirst({
      where: { id: input.addressId, businessId: input.businessId, customerId: input.customerId, deletedAt: null }
    });
    if (!existing) return null;
    return this.prisma.serviceAddress.update({
      where: { id: existing.id },
      data: { label: input.label, addressText: input.addressText, normalizedAddress: input.normalizedAddress }
    });
  }

  async softDelete(input: { businessId: string; customerId: string; addressId: string; deletedByUserId: string }) {
    const existing = await this.prisma.serviceAddress.findFirst({
      where: { id: input.addressId, businessId: input.businessId, customerId: input.customerId, deletedAt: null }
    });
    if (!existing) return null;
    return this.prisma.serviceAddress.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), deletedByUserId: input.deletedByUserId }
    });
  }
}

@Injectable()
export class V2TasksRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: {
    businessId: string;
    customerId?: string;
    title: string;
    description?: string;
    dueAt?: Date;
    status?: TaskStatus;
    source: string;
    idempotencyKey: string;
  }) {
    await this.businesses.requireBusiness(input.businessId);
    if (input.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: input.customerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null }
      });
      if (!customer) return null;
    }
    return this.prisma.task.create({ data: input });
  }

  async list(businessId: string, pagination: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.task.findMany({
      where: { businessId, deletedAt: null, ...createdAtCursorWhere(pagination.cursor) },
      include: { customer: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
    });
  }

  findById(businessId: string, taskId: string) {
    return this.prisma.task.findFirst({
      where: { id: taskId, businessId, deletedAt: null },
      include: { customer: true }
    });
  }

  async update(input: {
    businessId: string;
    taskId: string;
    customerId?: string | null;
    title?: string;
    description?: string | null;
    dueAt?: Date | null;
    status?: TaskStatus;
    version?: number;
  }) {
    if (input.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: input.customerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null }
      });
      if (!customer) return null;
    }
    const updated = await this.prisma.task.updateMany({
      where: { id: input.taskId, businessId: input.businessId, deletedAt: null, version: input.version },
      data: {
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        dueAt: input.dueAt,
        status: input.status,
        reminderSentAt: input.dueAt !== undefined ? null : undefined,
        version: { increment: 1 }
      }
    });
    return updated.count === 1 ? this.findById(input.businessId, input.taskId) : null;
  }

  async softDelete(input: { businessId: string; taskId: string; deletedByUserId: string }) {
    const updated = await this.prisma.task.updateMany({
      where: { id: input.taskId, businessId: input.businessId, deletedAt: null },
      data: { deletedAt: new Date(), deletedByUserId: input.deletedByUserId, version: { increment: 1 } }
    });
    return updated.count === 1 ? this.prisma.task.findUnique({ where: { id: input.taskId } }) : null;
  }

  async claimDue(limit: number) {
    const candidates = await this.prisma.task.findMany({
      where: { status: "OPEN", deletedAt: null, dueAt: { lte: new Date() }, reminderSentAt: null },
      orderBy: { dueAt: "asc" },
      take: limit
    });
    const claimed = [];
    for (const candidate of candidates) {
      const reminderSentAt = new Date();
      const result = await this.prisma.task.updateMany({
        where: { id: candidate.id, status: "OPEN", deletedAt: null, reminderSentAt: null },
        data: { reminderSentAt }
      });
      if (result.count === 1) claimed.push({ ...candidate, reminderSentAt });
    }
    return claimed;
  }
}
