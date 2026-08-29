import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service.js";
import { createdAtCursorWhere, paginationTake, type AuditEventInput, type CreateBusinessMemberInput, type CreateBusinessPhoneNumberInput, type DisableBusinessMemberInput, type PaginationInput, type RegisterBusinessInput, type UpdateBusinessPhoneNumberInput, type UpdateBusinessSettingsInput } from "./repository.shared.js";

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

  async listByBusiness(businessId: string, pagination?: PaginationInput) {
    return this.prisma.auditEvent.findMany({
      where: {
        businessId,
        ...createdAtCursorWhere(pagination?.cursor)
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: paginationTake(pagination)
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
        reminderPrompt: "הבקשה התקבלה. נחזור אליך בהקדם.",
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
        reminderPrompt: input.reminderPrompt,
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

