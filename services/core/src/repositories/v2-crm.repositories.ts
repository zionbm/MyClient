import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
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

  async findByNormalizedPhone(businessId: string, normalizedPhone: string) {
    if (!normalizedPhone) return null;
    return this.prisma.customer.findFirst({
      where: {
        businessId,
        deletedAt: null,
        mergedIntoCustomerId: null,
        customerPhones: { some: { normalizedPhone, deletedAt: null } }
      },
      include: {
        customerPhones: { where: { deletedAt: null }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        serviceAddresses: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } }
      }
    });
  }

  async timeline(businessId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId, deletedAt: null, mergedIntoCustomerId: null },
      select: { id: true }
    });
    if (!customer) return null;
    const [tasks, jobs, visits, notes] = await Promise.all([
      this.prisma.task.findMany({ where: { businessId, customerId, deletedAt: null } }),
      this.prisma.job.findMany({ where: { businessId, customerId, deletedAt: null } }),
      this.prisma.visit.findMany({ where: { businessId, customerId, deletedAt: null } }),
      this.prisma.note.findMany({ where: { businessId, customerId, deletedAt: null } })
    ]);
    return [
      ...tasks.map((item) => ({ type: "task", occurredAt: item.dueAt ?? item.createdAt, item })),
      ...jobs.map((item) => ({ type: "job", occurredAt: item.startsAt ?? item.createdAt, item })),
      ...visits.map((item) => ({ type: "visit", occurredAt: item.startsAt ?? item.createdAt, item })),
      ...notes.map((item) => ({ type: "note", occurredAt: item.createdAt, item }))
    ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
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

  async softDelete(input: { businessId: string; customerId: string; deletedByUserId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null }
      });
      if (!customer) return null;
      const deletedAt = new Date();
      const batchId = randomUUID();
      const marker = { deletedAt, deletedByUserId: input.deletedByUserId, deleteActionBatchId: batchId };
      await Promise.all([
        tx.customerPhone.updateMany({ where: { businessId: input.businessId, customerId: input.customerId, deletedAt: null }, data: { ...marker, isPrimary: false } }),
        tx.serviceAddress.updateMany({ where: { businessId: input.businessId, customerId: input.customerId, deletedAt: null }, data: marker }),
        tx.task.updateMany({ where: { businessId: input.businessId, customerId: input.customerId, deletedAt: null }, data: marker }),
        tx.job.updateMany({ where: { businessId: input.businessId, customerId: input.customerId, deletedAt: null }, data: marker }),
        tx.visit.updateMany({ where: { businessId: input.businessId, customerId: input.customerId, deletedAt: null }, data: marker })
      ]);
      await tx.amount.updateMany({
        where: {
          businessId: input.businessId,
          deletedAt: null,
          OR: [{ job: { customerId: input.customerId } }, { visit: { customerId: input.customerId } }]
        },
        data: marker
      });
      return tx.customer.update({
        where: { id: customer.id },
        data: { ...marker, version: { increment: 1 } }
      });
    });
  }

  async restore(input: { businessId: string; customerId: string }) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, businessId: input.businessId, deletedAt: { not: null }, deleteActionBatchId: { not: null } }
      });
      if (!customer?.deleteActionBatchId) return null;
      const batchId = customer.deleteActionBatchId;
      const where = { businessId: input.businessId, deleteActionBatchId: batchId };
      await Promise.all([
        tx.customerPhone.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } }),
        tx.serviceAddress.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } }),
        tx.task.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } }),
        tx.job.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } }),
        tx.visit.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } }),
        tx.amount.updateMany({ where, data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null } })
      ]);
      const phones = await tx.customerPhone.findMany({
        where: { businessId: input.businessId, customerId: input.customerId, deletedAt: null },
        orderBy: { createdAt: "asc" }
      });
      if (phones.length > 0 && !phones.some((phone) => phone.isPrimary)) {
        await tx.customerPhone.update({ where: { id: phones[0]!.id }, data: { isPrimary: true } });
      }
      return tx.customer.update({
        where: { id: customer.id },
        data: { deletedAt: null, deletedByUserId: null, deleteActionBatchId: null, version: { increment: 1 } }
      });
    });
  }

  async merge(input: { businessId: string; sourceCustomerId: string; targetCustomerId: string; actorUserId: string }) {
    if (input.sourceCustomerId === input.targetCustomerId) return null;
    return this.prisma.$transaction(async (tx) => {
      const [source, target] = await Promise.all([
        tx.customer.findFirst({ where: { id: input.sourceCustomerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null } }),
        tx.customer.findFirst({ where: { id: input.targetCustomerId, businessId: input.businessId, deletedAt: null, mergedIntoCustomerId: null } })
      ]);
      if (!source || !target) return null;
      const sourcePhones = await tx.customerPhone.findMany({
        where: { businessId: input.businessId, customerId: source.id, deletedAt: null }
      });
      for (const phone of sourcePhones) {
        const duplicate = await tx.customerPhone.findFirst({
          where: { businessId: input.businessId, customerId: target.id, normalizedPhone: phone.normalizedPhone, deletedAt: null }
        });
        if (duplicate) {
          await tx.customerPhone.update({ where: { id: phone.id }, data: { deletedAt: new Date(), deletedByUserId: input.actorUserId, isPrimary: false } });
        } else {
          await tx.customerPhone.update({ where: { id: phone.id }, data: { customerId: target.id, isPrimary: false } });
        }
      }
      const sourceAddresses = await tx.serviceAddress.findMany({
        where: { businessId: input.businessId, customerId: source.id, deletedAt: null }
      });
      for (const address of sourceAddresses) {
        const duplicate = address.normalizedAddress
          ? await tx.serviceAddress.findFirst({
              where: { businessId: input.businessId, customerId: target.id, normalizedAddress: address.normalizedAddress, deletedAt: null }
            })
          : null;
        await tx.serviceAddress.update({
          where: { id: address.id },
          data: duplicate
            ? { deletedAt: new Date(), deletedByUserId: input.actorUserId }
            : { customerId: target.id }
        });
      }
      await Promise.all([
        tx.task.updateMany({ where: { businessId: input.businessId, customerId: source.id }, data: { customerId: target.id } }),
        tx.job.updateMany({ where: { businessId: input.businessId, customerId: source.id }, data: { customerId: target.id } }),
        tx.visit.updateMany({ where: { businessId: input.businessId, customerId: source.id }, data: { customerId: target.id } }),
        tx.note.updateMany({ where: { businessId: input.businessId, customerId: source.id }, data: { customerId: target.id } })
      ]);
      const mergedSource = await tx.customer.update({
        where: { id: source.id },
        data: {
          mergedIntoCustomerId: target.id,
          mergedAt: new Date(),
          mergedByUserId: input.actorUserId,
          version: { increment: 1 }
        }
      });
      const updatedTarget = await tx.customer.update({
        where: { id: target.id },
        data: { version: { increment: 1 } }
      });
      return { source: mergedSource, target: updatedTarget };
    });
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

  findByIdempotencyKey(businessId: string, idempotencyKey: string) {
    return this.prisma.task.findUnique({
      where: { businessId_idempotencyKey: { businessId, idempotencyKey } }
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
