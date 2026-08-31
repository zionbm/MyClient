import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service.js";
import { BusinessesRepository } from "./business.repositories.js";
import { createdAtCursorWhere, paginationTake, type CreateAppointmentInput, type CreateHomeVisitInput, type CreateQuoteInput, type PaginationInput, type UpdateAppointmentInput, type UpdateHomeVisitInput, type UpdateQuoteInput } from "./repository.shared.js";

@Injectable()
export class AppointmentsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateAppointmentInput) {
    await this.businesses.requireBusiness(input.businessId);
    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }

    return this.prisma.appointment.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        title: input.title,
        location: input.location,
        notes: input.notes,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: input.status
      }
    });
  }

  async listByBusiness(businessId: string, pagination?: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.appointment.findMany({
      where: {
        businessId,
        deletedAt: null,
        ...createdAtCursorWhere(pagination?.cursor)
      },
      include: { customer: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
    });
  }

  async listForDate(input: { businessId: string; start: Date; end: Date; search?: string; includeOpenBeforeStart?: boolean }) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.appointment.findMany({
      where: {
        businessId: input.businessId,
        deletedAt: null,
        OR: [
          {
            startsAt: {
              gte: input.start,
              lt: input.end
            }
          },
          ...(input.includeOpenBeforeStart ? [{
            status: "OPEN" as const,
            startsAt: {
              lt: input.start
            }
          }] : [])
        ],
        AND: input.search ? [{
          OR: [
          { title: { contains: input.search, mode: "insensitive" } },
          { location: { contains: input.search, mode: "insensitive" } },
          { notes: { contains: input.search, mode: "insensitive" } },
          { customer: { name: { contains: input.search, mode: "insensitive" } } },
          { customer: { phone: { contains: input.search, mode: "insensitive" } } }
          ]
        }] : undefined
      },
      include: { customer: true },
      orderBy: { startsAt: "asc" }
    });
  }

  async listByCustomer(businessId: string, customerId: string) {
    await this.ensureCustomerBelongsToBusiness(businessId, customerId);
    return this.prisma.appointment.findMany({
      where: {
        businessId,
        customerId,
        deletedAt: null
      },
      include: { customer: true },
      orderBy: { startsAt: "asc" }
    });
  }

  async listOpenForVoiceMatch(businessId: string, customerId?: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.appointment.findMany({
      where: {
        businessId,
        customerId,
        status: "OPEN",
        deletedAt: null
      },
      include: { customer: true },
      orderBy: [{ startsAt: "asc" }, { createdAt: "desc" }],
      take: 100
    });
  }

  async findByBusinessAndId(businessId: string, appointmentId: string) {
    return this.prisma.appointment.findFirst({
      where: { businessId, id: appointmentId, deletedAt: null },
      include: { customer: true }
    });
  }

  async update(input: UpdateAppointmentInput) {
    const existing = await this.prisma.appointment.findFirst({
      where: {
        businessId: input.businessId,
        id: input.appointmentId,
        deletedAt: null
      }
    });
    if (!existing) {
      return null;
    }

    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }

    return this.prisma.appointment.update({
      where: { id: existing.id },
      data: {
        customerId: input.customerId,
        title: input.title,
        location: input.location,
        notes: input.notes,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: input.status
      }
    });
  }

  async softDelete(businessId: string, appointmentId: string) {
    const existing = await this.prisma.appointment.findFirst({
      where: {
        businessId,
        id: appointmentId,
        deletedAt: null
      }
    });
    if (!existing) {
      return null;
    }
    return this.prisma.appointment.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() }
    });
  }

  private async ensureCustomerBelongsToBusiness(businessId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: {
        businessId,
        id: customerId,
        deletedAt: null
      },
      select: { id: true }
    });

    if (!customer) {
      throw new NotFoundException("Customer not found");
    }
  }
}

@Injectable()
export class HomeVisitsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateHomeVisitInput) {
    await this.businesses.requireBusiness(input.businessId);
    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }

    return this.prisma.homeVisit.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        title: input.title,
        location: input.location,
        notes: input.notes,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: input.status
      }
    });
  }

  async listByBusiness(businessId: string, pagination?: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.homeVisit.findMany({
      where: {
        businessId,
        deletedAt: null,
        ...createdAtCursorWhere(pagination?.cursor)
      },
      include: { customer: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
    });
  }

  async listForDate(input: { businessId: string; start: Date; end: Date; search?: string; includeOpenBeforeStart?: boolean }) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.homeVisit.findMany({
      where: {
        businessId: input.businessId,
        deletedAt: null,
        OR: [
          {
            startsAt: {
              gte: input.start,
              lt: input.end
            }
          },
          ...(input.includeOpenBeforeStart ? [{
            status: "OPEN" as const,
            startsAt: {
              lt: input.start
            }
          }] : [])
        ],
        AND: input.search ? [{
          OR: [
          { title: { contains: input.search, mode: "insensitive" } },
          { location: { contains: input.search, mode: "insensitive" } },
          { notes: { contains: input.search, mode: "insensitive" } },
          { customer: { name: { contains: input.search, mode: "insensitive" } } },
          { customer: { phone: { contains: input.search, mode: "insensitive" } } }
          ]
        }] : undefined
      },
      include: { customer: true },
      orderBy: { startsAt: "asc" }
    });
  }

  async listByCustomer(businessId: string, customerId: string) {
    await this.ensureCustomerBelongsToBusiness(businessId, customerId);
    return this.prisma.homeVisit.findMany({
      where: {
        businessId,
        customerId,
        deletedAt: null
      },
      include: { customer: true },
      orderBy: { startsAt: "asc" }
    });
  }

  async listOpenForVoiceMatch(businessId: string, customerId?: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.homeVisit.findMany({
      where: {
        businessId,
        customerId,
        status: "OPEN",
        deletedAt: null
      },
      include: { customer: true },
      orderBy: [{ startsAt: "asc" }, { createdAt: "desc" }],
      take: 100
    });
  }

  async findByBusinessAndId(businessId: string, homeVisitId: string) {
    return this.prisma.homeVisit.findFirst({
      where: { businessId, id: homeVisitId, deletedAt: null },
      include: { customer: true }
    });
  }

  async update(input: UpdateHomeVisitInput) {
    const existing = await this.prisma.homeVisit.findFirst({
      where: {
        businessId: input.businessId,
        id: input.homeVisitId,
        deletedAt: null
      }
    });
    if (!existing) {
      return null;
    }

    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }

    return this.prisma.homeVisit.update({
      where: { id: existing.id },
      data: {
        customerId: input.customerId,
        title: input.title,
        location: input.location,
        notes: input.notes,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: input.status
      }
    });
  }

  async complete(businessId: string, homeVisitId: string) {
    return this.update({ businessId, homeVisitId, status: "DONE" });
  }

  async softDelete(businessId: string, homeVisitId: string) {
    const existing = await this.prisma.homeVisit.findFirst({
      where: {
        businessId,
        id: homeVisitId,
        deletedAt: null
      }
    });
    if (!existing) {
      return null;
    }
    return this.prisma.homeVisit.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() }
    });
  }

  private async ensureCustomerBelongsToBusiness(businessId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: {
        businessId,
        id: customerId,
        deletedAt: null
      },
      select: { id: true }
    });

    if (!customer) {
      throw new NotFoundException("Customer not found");
    }
  }
}

@Injectable()
export class QuotesRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async findByIdempotencyKey(businessId: string, idempotencyKey: string) {
    return this.prisma.quote.findFirst({
      where: {
        businessId,
        idempotencyKey
      }
    });
  }

  async create(input: CreateQuoteInput) {
    await this.businesses.requireBusiness(input.businessId);
    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }
    return this.prisma.quote.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        estimatedAmount: input.estimatedAmount,
        dueAt: input.dueAt,
        status: input.status,
        source: input.source ?? "app",
        sourceRef: input.sourceRef,
        idempotencyKey: input.idempotencyKey
      }
    });
  }

  async listByBusiness(businessId: string, pagination?: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.quote.findMany({
      where: {
        businessId,
        deletedAt: null,
        ...createdAtCursorWhere(pagination?.cursor)
      },
      include: { customer: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
    });
  }

  async listForDate(input: { businessId: string; start: Date; end: Date; search?: string; includeOpenBeforeStart?: boolean }) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.quote.findMany({
      where: {
        businessId: input.businessId,
        deletedAt: null,
        OR: [
          {
            dueAt: {
              gte: input.start,
              lt: input.end
            }
          },
          ...(input.includeOpenBeforeStart ? [{
            status: "OPEN" as const,
            dueAt: {
              lt: input.start
            }
          }] : [])
        ],
        AND: input.search ? [{
          OR: [
          { title: { contains: input.search, mode: "insensitive" } },
          { description: { contains: input.search, mode: "insensitive" } },
          { customer: { name: { contains: input.search, mode: "insensitive" } } },
          { customer: { phone: { contains: input.search, mode: "insensitive" } } }
          ]
        }] : undefined
      },
      include: { customer: true },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }]
    });
  }

  async listByCustomer(businessId: string, customerId: string) {
    await this.ensureCustomerBelongsToBusiness(businessId, customerId);
    return this.prisma.quote.findMany({
      where: {
        businessId,
        customerId,
        deletedAt: null
      },
      include: { customer: true },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }]
    });
  }

  async listOpenForVoiceMatch(businessId: string, customerId?: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.quote.findMany({
      where: {
        businessId,
        customerId,
        status: "OPEN",
        deletedAt: null
      },
      include: { customer: true },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      take: 100
    });
  }

  async findByBusinessAndId(businessId: string, quoteId: string) {
    return this.prisma.quote.findFirst({
      where: {
        businessId,
        id: quoteId,
        deletedAt: null
      },
      include: { customer: true }
    });
  }

  async update(input: UpdateQuoteInput) {
    const existing = await this.findByBusinessAndId(input.businessId, input.quoteId);
    if (!existing) {
      return null;
    }
    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }
    return this.prisma.quote.update({
      where: { id: existing.id },
      data: {
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        estimatedAmount: input.estimatedAmount,
        dueAt: input.dueAt,
        status: input.status
      }
    });
  }

  async markPaid(businessId: string, quoteId: string) {
    const existing = await this.findByBusinessAndId(businessId, quoteId);
    if (!existing) {
      return null;
    }
    return this.prisma.quote.update({
      where: { id: existing.id },
      data: { status: "PAID" }
    });
  }

  async softDelete(businessId: string, quoteId: string) {
    const existing = await this.findByBusinessAndId(businessId, quoteId);
    if (!existing) {
      return null;
    }
    return this.prisma.quote.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() }
    });
  }

  async snooze(businessId: string, quoteId: string, dueAt: Date) {
    const existing = await this.findByBusinessAndId(businessId, quoteId);
    if (!existing || existing.deletedAt) {
      return null;
    }
    return this.prisma.quote.update({
      where: { id: existing.id },
      data: {
        dueAt,
        reminderSentAt: null,
        status: "OPEN"
      }
    });
  }

  private async ensureCustomerBelongsToBusiness(businessId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: {
        businessId,
        id: customerId,
        deletedAt: null
      },
      select: { id: true }
    });

    if (!customer) {
      throw new NotFoundException("Customer not found");
    }
  }
}
