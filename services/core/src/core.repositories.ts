import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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

type UpdateBusinessSettingsInput = {
  businessId: string;
  locale?: string;
  timezone?: string;
  greetingText?: string | null;
  callbackPrompt?: string | null;
  urgentPrompt?: string | null;
  workingHours?: Prisma.InputJsonValue | null;
  notificationPhone?: string | null;
  allowUrgentCalls?: boolean;
};

type CreateBusinessPhoneNumberInput = {
  businessId: string;
  plivoNumber: string;
  displayName?: string;
  status?: string;
};

type UpdateBusinessPhoneNumberInput = {
  businessId: string;
  phoneNumberId: string;
  displayName?: string | null;
  status?: string;
};

type CreateIncomingCallInput = {
  businessId: string;
  plivoCallId: string;
  fromNumber?: string;
  toNumber: string;
  selectedDigit?: string;
  urgent?: boolean;
  status: string;
};

type UpdateIncomingCallInput = {
  plivoCallId: string;
  status?: string;
  selectedDigit?: string;
  urgent?: boolean;
  recordingUrl?: string;
};

type CreateCallTranscriptInput = {
  businessId: string;
  incomingCallId: string;
  transcript: string;
  taskId?: string;
  provider?: string;
  confidence?: number;
};

type CreateAppointmentInput = {
  businessId: string;
  customerId?: string;
  title: string;
  startsAt: Date;
  endsAt?: Date | null;
};

type UpdateAppointmentInput = {
  businessId: string;
  appointmentId: string;
  customerId?: string | null;
  title?: string;
  startsAt?: Date;
  endsAt?: Date | null;
  status?: "SCHEDULED" | "CANCELLED" | "COMPLETED";
};

type CreateJobInput = {
  businessId: string;
  customerId: string;
  title: string;
  description?: string;
  status?: string;
};

type UpdateJobInput = {
  businessId: string;
  jobId: string;
  customerId?: string;
  title?: string;
  description?: string | null;
  status?: string;
};

type AuditEventInput = {
  businessId: string;
  actorType: string;
  actorId?: string;
  source: string;
  entityType: string;
  entityId?: string;
  action: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  result?: string;
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
export class AuditRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(input: AuditEventInput) {
    return this.prisma.auditEvent.create({
      data: {
        businessId: input.businessId,
        actorType: input.actorType,
        actorId: input.actorId,
        source: input.source,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        before: input.before,
        after: input.after,
        result: input.result ?? "SUCCESS"
      }
    });
  }

  async listByBusiness(businessId: string) {
    return this.prisma.auditEvent.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" }
    });
  }
}

@Injectable()
export class BusinessSettingsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async getByBusiness(businessId: string) {
    const business = await this.businesses.requireBusiness(businessId);
    return this.prisma.businessSettings.upsert({
      where: { businessId },
      update: {},
      create: {
        businessId,
        locale: "he-IL",
        timezone: "Asia/Jerusalem",
        greetingText: `שלום, הגעתם ל${business.name}. לחזרה טלפונית הקישו 1, להשארת הודעה הקישו 2, ולמקרה דחוף הקישו 3.`,
        callbackPrompt: "הבקשה התקבלה. נחזור אליך בהקדם.",
        urgentPrompt: "אנא השאר הודעה דחופה אחרי הצליל.",
        workingHours: {
          sunday: { open: "09:00", close: "17:00" },
          monday: { open: "09:00", close: "17:00" },
          tuesday: { open: "09:00", close: "17:00" },
          wednesday: { open: "09:00", close: "17:00" },
          thursday: { open: "09:00", close: "17:00" },
          friday: { open: "09:00", close: "13:00" },
          saturday: { open: "00:00", close: "00:00", closed: true }
        }
      }
    });
  }

  async update(input: UpdateBusinessSettingsInput) {
    await this.getByBusiness(input.businessId);
    const workingHours =
      input.workingHours === null ? Prisma.JsonNull : input.workingHours === undefined ? undefined : input.workingHours;
    return this.prisma.businessSettings.update({
      where: { businessId: input.businessId },
      data: {
        locale: input.locale,
        timezone: input.timezone,
        greetingText: input.greetingText,
        callbackPrompt: input.callbackPrompt,
        urgentPrompt: input.urgentPrompt,
        workingHours,
        notificationPhone: input.notificationPhone,
        allowUrgentCalls: input.allowUrgentCalls
      }
    });
  }
}

@Injectable()
export class BusinessPhoneNumbersRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateBusinessPhoneNumberInput) {
    await this.businesses.requireBusiness(input.businessId);
    const existing = await this.prisma.businessPhoneNumber.findUnique({
      where: { plivoNumber: input.plivoNumber },
      select: { id: true }
    });
    if (existing) {
      throw new ConflictException("Phone number is already registered");
    }

    return this.prisma.businessPhoneNumber.create({
      data: {
        businessId: input.businessId,
        plivoNumber: input.plivoNumber,
        displayName: input.displayName,
        status: input.status ?? "ACTIVE"
      }
    });
  }

  async listByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.businessPhoneNumber.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" }
    });
  }

  async update(input: UpdateBusinessPhoneNumberInput) {
    const existing = await this.prisma.businessPhoneNumber.findFirst({
      where: {
        id: input.phoneNumberId,
        businessId: input.businessId
      }
    });
    if (!existing) {
      return null;
    }

    return this.prisma.businessPhoneNumber.update({
      where: { id: existing.id },
      data: {
        displayName: input.displayName,
        status: input.status
      }
    });
  }

  async findActiveByNumber(plivoNumber: string) {
    return this.prisma.businessPhoneNumber.findFirst({
      where: {
        plivoNumber,
        status: "ACTIVE"
      },
      include: {
        business: {
          include: {
            settings: true
          }
        }
      }
    });
  }
}

@Injectable()
export class IncomingCallsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async createOrUpdate(input: CreateIncomingCallInput) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.incomingCall.upsert({
      where: { plivoCallId: input.plivoCallId },
      update: {
        fromNumber: input.fromNumber,
        toNumber: input.toNumber,
        status: input.status,
        selectedDigit: input.selectedDigit,
        urgent: input.urgent ?? false
      },
      create: {
        businessId: input.businessId,
        plivoCallId: input.plivoCallId,
        fromNumber: input.fromNumber,
        toNumber: input.toNumber,
        status: input.status,
        selectedDigit: input.selectedDigit,
        urgent: input.urgent ?? false
      }
    });
  }

  async update(input: UpdateIncomingCallInput) {
    return this.prisma.incomingCall.update({
      where: { plivoCallId: input.plivoCallId },
      data: {
        status: input.status,
        selectedDigit: input.selectedDigit,
        urgent: input.urgent,
        recordingUrl: input.recordingUrl
      }
    });
  }

  async findByPlivoCallId(plivoCallId: string) {
    return this.prisma.incomingCall.findUnique({
      where: { plivoCallId }
    });
  }

  async listByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.incomingCall.findMany({
      where: { businessId },
      include: { transcripts: true },
      orderBy: { createdAt: "desc" }
    });
  }
}

@Injectable()
export class CallTranscriptsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateCallTranscriptInput) {
    return this.prisma.callTranscript.create({
      data: {
        businessId: input.businessId,
        incomingCallId: input.incomingCallId,
        transcript: input.transcript,
        taskId: input.taskId,
        provider: input.provider ?? "mock",
        confidence: input.confidence
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
        startsAt: input.startsAt,
        endsAt: input.endsAt
      }
    });
  }

  async listByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.appointment.findMany({
      where: { businessId },
      orderBy: { startsAt: "asc" }
    });
  }

  async update(input: UpdateAppointmentInput) {
    const existing = await this.prisma.appointment.findFirst({
      where: {
        businessId: input.businessId,
        id: input.appointmentId
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
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: input.status
      }
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
export class JobsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateJobInput) {
    await this.businesses.requireBusiness(input.businessId);
    await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);

    return this.prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        status: input.status ?? "OPEN"
      }
    });
  }

  async listByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.job.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" }
    });
  }

  async update(input: UpdateJobInput) {
    const existing = await this.prisma.job.findFirst({
      where: {
        businessId: input.businessId,
        id: input.jobId
      }
    });
    if (!existing) {
      return null;
    }

    if (input.customerId) {
      await this.ensureCustomerBelongsToBusiness(input.businessId, input.customerId);
    }

    return this.prisma.job.update({
      where: { id: existing.id },
      data: {
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        status: input.status
      }
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
