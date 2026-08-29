import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service.js";
import { BusinessesRepository } from "./business.repositories.js";
import { createdAtCursorWhere, mergeCustomerFields, paginationTake, type CreateCustomerInput, type CreateNoteInput, type CreateReminderInput, type CustomerMergeChoice, type CustomerMergeField, type PaginationInput, type UpdateCustomerInput, type UpdateNoteInput, type UpdateReminderInput } from "./repository.shared.js";

@Injectable()
export class RemindersRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async findByIdempotencyKey(businessId: string, idempotencyKey: string) {
    return this.prisma.reminder.findFirst({
      where: {
        businessId,
        idempotencyKey
      }
    });
  }

  async create(input: CreateReminderInput) {
    await this.businesses.requireBusiness(input.businessId);
    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }

    return this.prisma.reminder.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        priority: input.priority ?? "NORMAL",
        dueAt: input.dueAt,
        status: input.status,
        source: input.source,
        sourceRef: input.sourceRef,
        idempotencyKey: input.idempotencyKey
      }
    });
  }

  async listByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.reminder.findMany({
      where: { businessId, deletedAt: null },
      include: { customer: true },
      orderBy: { createdAt: "desc" }
    });
  }

  async listRemindersByBusiness(businessId: string, pagination?: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.reminder.findMany({
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

  async listRemindersForDate(input: { businessId: string; start: Date; end: Date; search?: string; urgentOnly?: boolean; includeOpenBeforeStart?: boolean }) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.reminder.findMany({
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
        priority: input.urgentOnly ? "URGENT" : undefined,
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
      orderBy: [{ priority: "desc" }, { dueAt: "asc" }, { createdAt: "desc" }]
    });
  }

  async listByCustomer(businessId: string, customerId: string) {
    await this.ensureCustomerBelongsToBusiness(businessId, customerId);
    return this.prisma.reminder.findMany({
      where: {
        businessId,
        customerId,
        deletedAt: null
      },
      include: { customer: true },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }]
    });
  }

  async claimDueReminders(limit: number) {
    const candidates = await this.prisma.reminder.findMany({
      where: {
        status: "OPEN",
        deletedAt: null,
        dueAt: {
          lte: new Date()
        },
        reminderSentAt: null
      },
      orderBy: { dueAt: "asc" },
      take: limit
    });
    const claimed = [];

    for (const candidate of candidates) {
      const reminderSentAt = new Date();
      const result = await this.prisma.reminder.updateMany({
        where: {
          id: candidate.id,
          status: "OPEN",
          deletedAt: null,
          reminderSentAt: null
        },
        data: { reminderSentAt }
      });
      if (result.count === 1) {
        claimed.push({ ...candidate, reminderSentAt });
      }
    }

    return claimed;
  }

  async findByBusinessAndId(businessId: string, reminderId: string) {
    return this.prisma.reminder.findFirst({
      where: {
        businessId,
        id: reminderId,
        deletedAt: null
      }
    });
  }

  async update(input: UpdateReminderInput) {
    const existing = await this.findByBusinessAndId(input.businessId, input.reminderId);
    if (!existing) {
      return null;
    }

    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }

    const dueAtChanged = input.dueAt !== undefined &&
      (existing.dueAt?.getTime() ?? null) !== (input.dueAt?.getTime() ?? null);
    const reopened = input.status === "OPEN" && existing.status !== "OPEN";

    return this.prisma.reminder.update({
      where: { id: existing.id },
      data: {
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        dueAt: input.dueAt,
        status: input.status,
        reminderSentAt: dueAtChanged || reopened ? null : undefined
      }
    });
  }

  async complete(businessId: string, reminderId: string) {
    const existing = await this.findByBusinessAndId(businessId, reminderId);
    if (!existing) {
      return null;
    }

    return this.prisma.reminder.update({
      where: { id: existing.id },
      data: { status: "DONE" }
    });
  }

  async softDelete(businessId: string, reminderId: string) {
    const existing = await this.findByBusinessAndId(businessId, reminderId);
    if (!existing) {
      return null;
    }

    return this.prisma.reminder.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() }
    });
  }

  async snooze(businessId: string, reminderId: string, dueAt: Date) {
    const existing = await this.findByBusinessAndId(businessId, reminderId);
    if (!existing || existing.deletedAt) {
      return null;
    }

    return this.prisma.reminder.update({
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

  async listByBusiness(businessId: string, pagination?: PaginationInput) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.customer.findMany({
      where: {
        businessId,
        deletedAt: null,
        mergedIntoCustomerId: null,
        ...createdAtCursorWhere(pagination?.cursor)
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
    });
  }

  async findByBusinessAndId(businessId: string, customerId: string) {
    return this.prisma.customer.findFirst({
      where: {
        businessId,
        id: customerId,
        deletedAt: null
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

  async softDelete(input: { businessId: string; customerId: string }) {
    const existing = await this.findByBusinessAndId(input.businessId, input.customerId);
    if (!existing) {
      return null;
    }

    const deletedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      const [reminders, appointments, homeVisits, quotes, notes] = await Promise.all([
        tx.reminder.updateMany({
          where: {
            businessId: input.businessId,
            customerId: existing.id,
            deletedAt: null
          },
          data: { deletedAt }
        }),
        tx.appointment.updateMany({
          where: {
            businessId: input.businessId,
            customerId: existing.id,
            deletedAt: null
          },
          data: { deletedAt }
        }),
        tx.homeVisit.updateMany({
          where: {
            businessId: input.businessId,
            customerId: existing.id,
            deletedAt: null
          },
          data: { deletedAt }
        }),
        tx.quote.updateMany({
          where: {
            businessId: input.businessId,
            customerId: existing.id,
            deletedAt: null
          },
          data: { deletedAt }
        }),
        tx.note.updateMany({
          where: {
            businessId: input.businessId,
            customerId: existing.id,
            deletedAt: null
          },
          data: { deletedAt }
        })
      ]);

      const customer = await tx.customer.update({
        where: { id: existing.id },
        data: { deletedAt }
      });

      return {
        customer,
        deleted: {
          reminders: reminders.count,
          homeVisits: homeVisits.count,
          appointments: appointments.count,
          quotes: quotes.count,
          notes: notes.count
        }
      };
    });
  }

  async findDuplicateByPhone(businessId: string, phone?: string) {
    if (!phone) {
      return null;
    }
    return this.prisma.customer.findFirst({
      where: {
        businessId,
        phone,
        deletedAt: null,
        mergedIntoCustomerId: null
      }
    });
  }

  async merge(input: {
    businessId: string;
    sourceCustomerId: string;
    targetCustomerId: string;
    mergedByUserId: string;
    fieldChoices?: Partial<Record<"name" | "phone" | "email" | "address", "source" | "target">>;
  }) {
    if (input.sourceCustomerId === input.targetCustomerId) {
      throw new BadRequestException("Source and target customer must be different");
    }
    const [source, target] = await Promise.all([
      this.findByBusinessAndId(input.businessId, input.sourceCustomerId),
      this.findByBusinessAndId(input.businessId, input.targetCustomerId)
    ]);
    if (!source || !target) {
      return null;
    }
    const customerUpdates = mergeCustomerFields(source, target, input.fieldChoices);

    return this.prisma.$transaction(async (tx) => {
      const [reminders, appointments, homeVisits, quotes, notes] = await Promise.all([
        tx.reminder.updateMany({
          where: { businessId: input.businessId, customerId: source.id },
          data: { customerId: target.id }
        }),
        tx.appointment.updateMany({
          where: { businessId: input.businessId, customerId: source.id },
          data: { customerId: target.id }
        }),
        tx.homeVisit.updateMany({
          where: { businessId: input.businessId, customerId: source.id },
          data: { customerId: target.id }
        }),
        tx.quote.updateMany({
          where: { businessId: input.businessId, customerId: source.id },
          data: { customerId: target.id }
        }),
        tx.note.updateMany({
          where: { businessId: input.businessId, customerId: source.id },
          data: { customerId: target.id }
        })
      ]);
      const updatedTarget = Object.keys(customerUpdates).length > 0
        ? await tx.customer.update({
            where: { id: target.id },
            data: customerUpdates
          })
        : target;
      const mergedSource = await tx.customer.update({
        where: { id: source.id },
        data: {
          deletedAt: new Date(),
          mergedIntoCustomerId: target.id,
          mergedAt: new Date(),
          mergedByUserId: input.mergedByUserId
        }
      });
      return {
        sourceCustomer: mergedSource,
        targetCustomer: updatedTarget,
        moved: {
          reminders: reminders.count,
          homeVisits: homeVisits.count,
          appointments: appointments.count,
          quotes: quotes.count,
          notes: notes.count
        }
      };
    });
  }
}

@Injectable()
export class NotesRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateNoteInput) {
    await this.businesses.requireBusiness(input.businessId);
    const customer = await this.prisma.customer.findFirst({
      where: {
        businessId: input.businessId,
        id: input.customerId,
        deletedAt: null
      },
      select: { id: true }
    });

    if (!customer) {
      return null;
    }

    return this.prisma.note.create({
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
        id: customerId,
        deletedAt: null
      },
      select: { id: true }
    });

    if (!customer) {
      return null;
    }

      return this.prisma.note.findMany({
        where: {
          businessId,
          customerId,
          deletedAt: null
        },
        orderBy: { createdAt: "desc" }
      });
  }

  async update(input: UpdateNoteInput) {
    const existing = await this.prisma.note.findFirst({
      where: {
        businessId: input.businessId,
        customerId: input.customerId,
        id: input.noteId,
        deletedAt: null,
        customer: {
          deletedAt: null
        }
      }
    });

    if (!existing) {
      return null;
    }

    return this.prisma.note.update({
      where: { id: existing.id },
      data: {
        text: input.text,
        status: input.status
      }
    });
  }

  async findByBusinessAndId(businessId: string, noteId: string) {
    return this.prisma.note.findFirst({
      where: {
        businessId,
        id: noteId,
        deletedAt: null,
        customer: {
          deletedAt: null
        }
      }
    });
  }

  async softDelete(businessId: string, noteId: string, customerId?: string) {
    const existing = customerId
      ? await this.prisma.note.findFirst({
          where: {
            businessId,
            customerId,
            id: noteId,
            deletedAt: null,
            customer: {
              deletedAt: null
            }
          }
        })
      : await this.findByBusinessAndId(businessId, noteId);
    if (!existing) {
      return null;
    }

    return this.prisma.note.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() }
    });
  }
}

