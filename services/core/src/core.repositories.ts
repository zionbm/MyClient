import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service.js";

type CreateTaskInput = {
  businessId: string;
  customerId?: string;
  title: string;
  description?: string;
  priority?: "NORMAL" | "URGENT";
  dueAt?: Date;
  status?: "OPEN" | "COMPLETED" | "CANCELLED";
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

type CreateBusinessMemberInput = {
  businessId: string;
  phoneNumber: string;
  displayName?: string;
  memberType?: "OWNER" | "EMPLOYEE";
  addedByUserId?: string;
};

type DisableBusinessMemberInput = {
  businessId: string;
  memberId: string;
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
  phone?: string | null;
  email?: string | null;
  address?: string | null;
};

type CreateCustomerNoteInput = {
  businessId: string;
  customerId: string;
  text: string;
};

type UpdateCustomerNoteInput = {
  businessId: string;
  customerId: string;
  noteId: string;
  status?: string;
};

type CreateNotificationInput = {
  businessId: string;
  taskId?: string;
  itemType?: string;
  itemId?: string;
  title: string;
  body: string;
  payload?: Prisma.InputJsonValue;
};

type CreatePendingActionInput = {
  businessId: string;
  userId?: string;
  actionType: string;
  source?: string;
  confidence?: number;
  reviewReason?: string;
  payload: Prisma.InputJsonValue;
  missingFields: string[];
};

type UpdatePendingActionInput = {
  businessId: string;
  pendingActionId: string;
  payload?: Prisma.InputJsonValue;
  missingFields?: string[];
  reviewReason?: string | null;
};

type UpdateNotificationInput = {
  businessId: string;
  notificationId: string;
  status: "PENDING" | "SENT" | "FAILED" | "READ";
  failureReason?: string;
};

type RegisterDeviceTokenInput = {
  businessId: string;
  userId: string;
  token: string;
  platform?: string;
  appVersion?: string;
};

type ResolvePendingActionInput = {
  businessId: string;
  pendingActionId: string;
  status: "EXECUTED" | "REJECTED";
  resolution?: Prisma.InputJsonValue;
};

type CreateOwnerVoiceCommandInput = {
  businessId: string;
  userId: string;
  languageCode: string;
  idempotencyKey: string;
};

type UpdateOwnerVoiceCommandInput = {
  id: string;
  transcript?: string;
  sttProvider?: string;
  sttConfidence?: number;
  llmProvider?: string;
  llmAction?: Prisma.InputJsonValue;
  executionStatus?: string;
  executionResult?: Prisma.InputJsonValue;
};

type RegisterBusinessInput = {
  firebaseUid: string;
  email?: string;
  phoneNumber?: string;
  displayName: string;
  businessName: string;
};

type UpdateBusinessSettingsInput = {
  businessId: string;
  actorUserId?: string;
  businessName?: string;
  ownerDisplayName?: string;
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
  location?: string;
  notes?: string;
  startsAt: Date;
  endsAt?: Date | null;
  status?: "SCHEDULED" | "CANCELLED" | "COMPLETED";
};

type UpdateAppointmentInput = {
  businessId: string;
  appointmentId: string;
  customerId?: string | null;
  title?: string;
  location?: string | null;
  notes?: string | null;
  startsAt?: Date;
  endsAt?: Date | null;
  status?: "SCHEDULED" | "CANCELLED" | "COMPLETED";
};

type CreateQuoteInput = {
  businessId: string;
  customerId?: string;
  title: string;
  description?: string;
  estimatedAmount?: Prisma.Decimal | number | string;
  dueAt: Date;
  status?: "OPEN" | "PAID";
  source?: string;
  sourceRef?: string;
  idempotencyKey?: string;
};

type UpdateQuoteInput = {
  businessId: string;
  quoteId: string;
  customerId?: string | null;
  title?: string;
  description?: string | null;
  estimatedAmount?: Prisma.Decimal | number | string | null;
  dueAt?: Date;
  status?: "OPEN" | "PAID";
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

  async updateName(businessId: string, name: string) {
    await this.requireBusiness(businessId);
    return this.prisma.business.update({
      where: { id: businessId },
      data: { name }
    });
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

    if (input.email) {
      const emailUser = await this.prisma.user.findUnique({
        where: { email: input.email },
        select: { id: true }
      });

      if (emailUser) {
        throw new ConflictException("Email is already registered");
      }
    }

    if (input.phoneNumber) {
      const phoneUser = await this.prisma.user.findUnique({
        where: { phoneNumber: input.phoneNumber },
        select: { id: true }
      });

      if (phoneUser) {
        throw new ConflictException("Phone number is already registered");
      }
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
          phoneNumber: input.phoneNumber,
          displayName: input.displayName,
          firebaseUid: input.firebaseUid
        }
      });

      const member = input.phoneNumber
        ? await tx.businessMember.create({
          data: {
            businessId: business.id,
            userId: user.id,
            phoneNumber: input.phoneNumber,
            memberType: "OWNER",
            status: "ACTIVE",
            linkedAt: new Date()
          }
        })
        : null;

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
              phoneNumber: user.phoneNumber,
              displayName: user.displayName,
              firebaseUid: user.firebaseUid
            }
          }
        ]
      });

      return {
        created: true,
        business,
        user,
        member
      };
    });
  }

  async getMe(firebaseUid: string, phoneNumber?: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        business: true,
        memberships: {
          where: { status: "ACTIVE" },
          include: { business: true },
          take: 1
        }
      }
    });

    if (!user) {
      return null;
    }

    if (!user.phoneNumber && phoneNumber) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { phoneNumber }
      });
    }

    if (user.memberships.length > 0) {
      return user;
    }

    const effectivePhoneNumber = phoneNumber ?? user.phoneNumber;
    if (!effectivePhoneNumber) {
      return user;
    }

    const pendingMember = await this.prisma.businessMember.findFirst({
      where: {
        phoneNumber: effectivePhoneNumber,
        userId: null,
        status: "PENDING"
      },
      include: { business: true },
      orderBy: { createdAt: "asc" }
    });
    if (!pendingMember) {
      return user;
    }

    await this.prisma.$transaction([
      this.prisma.businessMember.update({
        where: { id: pendingMember.id },
        data: {
          userId: user.id,
          status: "ACTIVE",
          linkedAt: new Date()
        }
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          businessId: pendingMember.businessId,
          phoneNumber: effectivePhoneNumber
        }
      })
    ]);

    return this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        business: true,
        memberships: {
          where: { status: "ACTIVE" },
          include: { business: true },
          take: 1
        }
      }
    });
  }
}

@Injectable()
export class BusinessMembersRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async listByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.businessMember.findMany({
      where: { businessId },
      include: { user: true },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }]
    });
  }

  async upsertByPhone(input: CreateBusinessMemberInput) {
    await this.businesses.requireBusiness(input.businessId);
    const existingUser = await this.prisma.user.findUnique({
      where: { phoneNumber: input.phoneNumber },
      select: { id: true }
    });
    return this.prisma.businessMember.upsert({
      where: {
        businessId_phoneNumber: {
          businessId: input.businessId,
          phoneNumber: input.phoneNumber
        }
      },
      update: {
        userId: existingUser?.id,
        displayName: input.displayName,
        memberType: input.memberType ?? "EMPLOYEE",
        status: existingUser ? "ACTIVE" : "PENDING",
        linkedAt: existingUser ? new Date() : undefined,
        addedByUserId: input.addedByUserId
      },
      create: {
        businessId: input.businessId,
        userId: existingUser?.id,
        phoneNumber: input.phoneNumber,
        displayName: input.displayName,
        memberType: input.memberType ?? "EMPLOYEE",
        status: existingUser ? "ACTIVE" : "PENDING",
        linkedAt: existingUser ? new Date() : undefined,
        addedByUserId: input.addedByUserId
      }
    });
  }

  async disable(input: DisableBusinessMemberInput) {
    const existing = await this.prisma.businessMember.findFirst({
      where: {
        id: input.memberId,
        businessId: input.businessId
      }
    });
    if (!existing) {
      return null;
    }
    return this.prisma.businessMember.update({
      where: { id: existing.id },
      data: { status: "DISABLED" }
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
    const owner = await this.prisma.user.findFirst({
      where: { businessId },
      orderBy: { createdAt: "asc" },
      select: { displayName: true }
    });
    const ownerDisplayName = owner?.displayName ?? "שם בעל העסק";
    const settings = await this.prisma.businessSettings.upsert({
      where: { businessId },
      update: {},
      create: {
        businessId,
        locale: "he-IL",
        timezone: "Asia/Jerusalem",
        greetingText: `שלום הגעתם ל${business.name}, ${ownerDisplayName} לא יכול לענות כרגע אבל יחזור אליכם בהקדם האפשרי. הקישו 1 לבקשת חזרה. הקישו 2 לבקשת חזרה עם השארת הודעה. הקישו 3 לפנייה דחופה.`,
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
    return {
      ...settings,
      businessName: business.name,
      ownerDisplayName: owner?.displayName ?? null
    };
  }

  async update(input: UpdateBusinessSettingsInput) {
    await this.getByBusiness(input.businessId);
    if (input.businessName) {
      await this.businesses.updateName(input.businessId, input.businessName);
    }
    if (input.ownerDisplayName && input.actorUserId) {
      await this.prisma.user.update({
        where: { id: input.actorUserId },
        data: { displayName: input.ownerDisplayName }
      });
    }
    const workingHours =
      input.workingHours === null ? Prisma.JsonNull : input.workingHours === undefined ? undefined : input.workingHours;
    const settings = await this.prisma.businessSettings.update({
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
    const business = await this.businesses.requireBusiness(input.businessId);
    const owner = await this.prisma.user.findFirst({
      where: { businessId: input.businessId },
      orderBy: { createdAt: "asc" },
      select: { displayName: true }
    });
    return {
      ...settings,
      businessName: business.name,
      ownerDisplayName: owner?.displayName ?? null
    };
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
export class OwnerVoiceCommandsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessesRepository) private readonly businesses: BusinessesRepository
  ) {}

  async create(input: CreateOwnerVoiceCommandInput) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.ownerVoiceCommand.create({
      data: {
        businessId: input.businessId,
        userId: input.userId,
        languageCode: input.languageCode,
        idempotencyKey: input.idempotencyKey,
        executionStatus: "RECEIVED"
      }
    });
  }

  async findByIdempotencyKey(idempotencyKey: string) {
    return this.prisma.ownerVoiceCommand.findUnique({
      where: { idempotencyKey }
    });
  }

  async listByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.ownerVoiceCommand.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" }
    });
  }

  async update(input: UpdateOwnerVoiceCommandInput) {
    return this.prisma.ownerVoiceCommand.update({
      where: { id: input.id },
      data: {
        transcript: input.transcript,
        sttProvider: input.sttProvider,
        sttConfidence: input.sttConfidence,
        llmProvider: input.llmProvider,
        llmAction: input.llmAction,
        executionStatus: input.executionStatus,
        executionResult: input.executionResult
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
        status: input.status,
        source: input.source,
        sourceRef: input.sourceRef,
        idempotencyKey: input.idempotencyKey
      }
    });
  }

  async listByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.task.findMany({
      where: { businessId, deletedAt: null },
      include: { customer: true },
      orderBy: { createdAt: "desc" }
    });
  }

  async listCallbacksByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.task.findMany({
      where: {
        businessId,
        deletedAt: null
      },
      include: { customer: true },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }]
    });
  }

  async listCallbacksForDate(input: { businessId: string; start: Date; end: Date; search?: string; urgentOnly?: boolean; includeOpenBeforeStart?: boolean }) {
    await this.businesses.requireBusiness(input.businessId);
    return this.prisma.task.findMany({
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
    return this.prisma.task.findMany({
      where: {
        businessId,
        customerId,
        deletedAt: null
      },
      include: { customer: true },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }]
    });
  }

  async listDueReminders(limit: number) {
    return this.prisma.task.findMany({
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

  async softDelete(businessId: string, taskId: string) {
    const existing = await this.findByBusinessAndId(businessId, taskId);
    if (!existing) {
      return null;
    }

    return this.prisma.task.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() }
    });
  }

  async snooze(businessId: string, taskId: string, dueAt: Date) {
    const existing = await this.findByBusinessAndId(businessId, taskId);
    if (!existing || existing.deletedAt) {
      return null;
    }

    return this.prisma.task.update({
      where: { id: existing.id },
      data: {
        dueAt,
        reminderSentAt: null,
        status: "OPEN"
      }
    });
  }

  async markReminderSent(taskId: string) {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { reminderSentAt: new Date() }
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
      where: {
        businessId,
        deletedAt: null,
        mergedIntoCustomerId: null
      },
      orderBy: { createdAt: "desc" }
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

  async merge(input: { businessId: string; sourceCustomerId: string; targetCustomerId: string; mergedByUserId: string }) {
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
    if (source.phone && target.phone && source.phone !== target.phone) {
      throw new BadRequestException("Cannot merge customers with conflicting phone numbers in the POC");
    }

    return this.prisma.$transaction(async (tx) => {
      const [tasks, appointments, quotes, notes] = await Promise.all([
        tx.task.updateMany({
          where: { businessId: input.businessId, customerId: source.id },
          data: { customerId: target.id }
        }),
        tx.appointment.updateMany({
          where: { businessId: input.businessId, customerId: source.id },
          data: { customerId: target.id }
        }),
        tx.quote.updateMany({
          where: { businessId: input.businessId, customerId: source.id },
          data: { customerId: target.id }
        }),
        tx.customerNote.updateMany({
          where: { businessId: input.businessId, customerId: source.id },
          data: { customerId: target.id }
        })
      ]);
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
        targetCustomer: target,
        moved: {
          callbacks: tasks.count,
          homeVisits: appointments.count,
          quotes: quotes.count,
          notes: notes.count
        }
      };
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

  async update(input: UpdateCustomerNoteInput) {
    const existing = await this.prisma.customerNote.findFirst({
      where: {
        businessId: input.businessId,
        customerId: input.customerId,
        id: input.noteId
      }
    });

    if (!existing) {
      return null;
    }

    return this.prisma.customerNote.update({
      where: { id: existing.id },
      data: {
        status: input.status
      }
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
        itemType: input.itemType,
        itemId: input.itemId,
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

  async listByBusinessAndStatus(businessId: string, status?: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.notification.findMany({
      where: {
        businessId,
        status: status as "PENDING" | "SENT" | "FAILED" | "READ" | undefined
      },
      orderBy: { createdAt: "desc" }
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
        source: input.source ?? "ai",
        confidence: input.confidence,
        reviewReason: input.reviewReason,
        payload: input.payload,
        missingFields: input.missingFields,
        status: "PENDING"
      }
    });
  }

  async listByBusinessAndStatus(businessId: string, status?: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.pendingAction.findMany({
      where: {
        businessId,
        status
      },
      orderBy: { createdAt: "desc" }
    });
  }

  async findByBusinessAndId(businessId: string, pendingActionId: string) {
    return this.prisma.pendingAction.findFirst({
      where: {
        businessId,
        id: pendingActionId
      }
    });
  }

  async resolve(input: ResolvePendingActionInput) {
    const existing = await this.findByBusinessAndId(input.businessId, input.pendingActionId);
    if (!existing) {
      return null;
    }

    return this.prisma.pendingAction.update({
      where: { id: existing.id },
      data: {
        status: input.status,
        resolution: input.resolution === undefined ? undefined : input.resolution,
        resolvedAt: new Date()
      }
    });
  }

  async update(input: UpdatePendingActionInput) {
    const existing = await this.findByBusinessAndId(input.businessId, input.pendingActionId);
    if (!existing) {
      return null;
    }
    if (existing.status !== "PENDING") {
      throw new BadRequestException("Pending action is already resolved");
    }
    return this.prisma.pendingAction.update({
      where: { id: existing.id },
      data: {
        payload: input.payload,
        missingFields: input.missingFields,
        reviewReason: input.reviewReason
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
        location: input.location,
        notes: input.notes,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: input.status
      }
    });
  }

  async listByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.appointment.findMany({
      where: { businessId, deletedAt: null },
      include: { customer: true },
      orderBy: { startsAt: "asc" }
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
            status: "SCHEDULED" as const,
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
        id: appointmentId
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

  async listByBusiness(businessId: string) {
    await this.businesses.requireBusiness(businessId);
    return this.prisma.quote.findMany({
      where: { businessId, deletedAt: null },
      include: { customer: true },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }]
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

  async findByBusinessAndId(businessId: string, quoteId: string) {
    return this.prisma.quote.findFirst({
      where: {
        businessId,
        id: quoteId
      }
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
