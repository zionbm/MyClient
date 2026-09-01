import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { health } from "@myclient/common";
import {
  capabilitiesForProductModelVersion,
  CreateBusinessMemberSchema,
  CreateBusinessPhoneNumberSchema,
  RegisterBusinessSchema,
  UpdateBusinessPhoneNumberSchema,
  UpdateBusinessSettingsSchema
} from "@myclient/contracts";
import {
  AuthRepository,
  AuditRepository,
  BusinessMembersRepository,
  BusinessPhoneNumbersRepository,
  BusinessSettingsRepository
} from "./core.repositories.js";
import { CoreAccessService } from "./core-access.service.js";
import { authProviderName, notificationProviderName, type RequestHeaders } from "./core-utils.js";

@Injectable()
export class CoreBusinessApplicationService {
  constructor(
    @Inject(AuthRepository) private readonly auth: AuthRepository,
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(BusinessMembersRepository) private readonly members: BusinessMembersRepository,
    @Inject(BusinessSettingsRepository) private readonly settings: BusinessSettingsRepository,
    @Inject(BusinessPhoneNumbersRepository) private readonly phoneNumbers: BusinessPhoneNumbersRepository
  ) {}

  health() {
    return health("core", {
      database: "postgresql-prisma",
      auth: authProviderName(),
      notifications: notificationProviderName()
    });
  }

  async registerBusiness(headers: RequestHeaders, body: unknown) {
    const command = RegisterBusinessSchema.parse(body);
    const verifiedAuth = await this.access.verifyAuth(headers, {
      mockFallback: command.firebaseUid
    });
    const email = command.email ?? verifiedAuth.email;
    const phoneNumber = command.phoneNumber ?? verifiedAuth.phoneNumber;
    const displayName = command.displayName ?? verifiedAuth.displayName ?? email ?? phoneNumber;
    const isMockAuth = authProviderName() === "mock";
    const mockDisplayName = displayName ?? command.firebaseUid ?? verifiedAuth.firebaseUid;
    if (!mockDisplayName) {
      throw new BadRequestException("Display name is required when it is not present in the Firebase token");
    }
    if (!email && !phoneNumber && !isMockAuth) {
      throw new BadRequestException("Phone number or email is required");
    }

    const result = await this.auth.registerBusiness({
      firebaseUid: verifiedAuth.firebaseUid,
      email,
      phoneNumber,
      displayName: mockDisplayName,
      businessName: command.businessName
    });
    if (!result.business) {
      throw new BadRequestException("Existing user is not linked to a business");
    }
    await this.settings.getByBusiness(result.business.id);
    return {
      created: result.created,
      business: result.business,
      user: {
        id: result.user.id,
        businessId: result.user.businessId,
        email: result.user.email,
        phoneNumber: result.user.phoneNumber,
        displayName: result.user.displayName,
        firebaseUid: result.user.firebaseUid,
        createdAt: result.user.createdAt,
        updatedAt: result.user.updatedAt
      }
    };
  }

  async me(headers: RequestHeaders) {
    const user = await this.access.requireAuthenticatedUser(headers);
    const membership = user.memberships?.[0] ?? null;
    const business = membership?.business ?? user.business;
    return {
      user: {
        id: user.id,
        businessId: user.businessId,
        email: user.email,
        phoneNumber: user.phoneNumber,
        displayName: user.displayName,
        firebaseUid: user.firebaseUid,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      },
      business,
      membership: membership ? {
        businessId: membership.businessId,
        memberType: membership.memberType,
        status: membership.status
      } : null,
      onboardingState: business ? "HAS_BUSINESS" : "NEEDS_CHOICE",
      capabilities: business
        ? capabilitiesForProductModelVersion(business.productModelVersion)
        : null
    };
  }

  async getSettings(headers: RequestHeaders, businessId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    return { settings: await this.settings.getByBusiness(businessId) };
  }

  async updateSettings(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateBusinessSettingsSchema.parse(body);
    const before = await this.settings.getByBusiness(businessId);
    const settings = await this.settings.update({
      businessId,
      actorUserId: user.id,
      businessName: command.businessName,
      ownerDisplayName: command.ownerDisplayName,
      locale: command.locale,
      timezone: command.timezone,
      greetingText: command.greetingText,
      reminderPrompt: command.reminderPrompt,
      urgentPrompt: command.urgentPrompt,
      workingHours: command.workingHours as Prisma.InputJsonValue | null | undefined,
      notificationPhone: command.notificationPhone,
      allowUrgentCalls: command.allowUrgentCalls
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "business_settings",
      entityId: settings.id,
      action: "UPDATE_SETTINGS",
      before: before as Prisma.InputJsonValue,
      after: settings as Prisma.InputJsonValue
    });
    return { settings };
  }

  async listMembers(headers: RequestHeaders, businessId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    return { members: await this.members.listByBusiness(businessId) };
  }

  async createMember(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = CreateBusinessMemberSchema.parse(body);
    const member = await this.members.upsertByPhone({
      businessId,
      phoneNumber: command.phoneNumber,
      displayName: command.displayName,
      memberType: command.memberType,
      addedByUserId: user.id
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "business_member",
      entityId: member.id,
      action: "UPSERT_BUSINESS_MEMBER",
      after: member as Prisma.InputJsonValue
    });
    return { member };
  }

  async disableMember(headers: RequestHeaders, businessId: string, memberId: string) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const member = await this.members.disable({ businessId, memberId });
    if (!member) {
      throw new NotFoundException("Business member not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "business_member",
      entityId: member.id,
      action: "DISABLE_BUSINESS_MEMBER",
      after: member as Prisma.InputJsonValue
    });
    return { member };
  }

  async listPhoneNumbers(headers: RequestHeaders, businessId: string) {
    await this.access.requireBusinessAccess(headers, businessId);
    return { phoneNumbers: await this.phoneNumbers.listByBusiness(businessId) };
  }

  async createPhoneNumber(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = CreateBusinessPhoneNumberSchema.parse(body);
    const phoneNumber = await this.phoneNumbers.create({
      businessId,
      plivoNumber: command.plivoNumber,
      displayName: command.displayName,
      status: command.status
    });
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "business_phone_number",
      entityId: phoneNumber.id,
      action: "CREATE_PHONE_NUMBER",
      after: phoneNumber as Prisma.InputJsonValue
    });
    return { phoneNumber };
  }

  async updatePhoneNumber(
    headers: RequestHeaders,
    businessId: string,
    phoneNumberId: string,
    body: unknown
  ) {
    const user = await this.access.requireBusinessAccess(headers, businessId);
    const command = UpdateBusinessPhoneNumberSchema.parse(body);
    const phoneNumber = await this.phoneNumbers.update({
      businessId,
      phoneNumberId,
      displayName: command.displayName,
      status: command.status
    });
    if (!phoneNumber) {
      throw new NotFoundException("Phone number not found");
    }
    await this.audit.record({
      businessId,
      actorType: "user",
      actorId: user.id,
      source: "core",
      entityType: "business_phone_number",
      entityId: phoneNumber.id,
      action: "UPDATE_PHONE_NUMBER",
      after: phoneNumber as Prisma.InputJsonValue
    });
    return { phoneNumber };
  }
}
