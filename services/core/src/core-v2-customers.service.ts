import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  V2CreateCustomerPhoneSchema,
  V2CreateCustomerSchema,
  V2CreateServiceAddressSchema,
  V2UpdateCustomerPhoneSchema,
  V2UpdateCustomerSchema,
  V2UpdateServiceAddressSchema
} from "@myclient/contracts";
import { CoreAccessService } from "./core-access.service.js";
import { CoreV2IdempotencyService } from "./core-v2-idempotency.service.js";
import {
  AuditRepository,
  V2CustomerPhonesRepository,
  V2CustomersRepository,
  V2ServiceAddressesRepository
} from "./core.repositories.js";
import {
  paginatedResponse,
  paginationFromQuery,
  requiredIdempotencyKey,
  type RequestHeaders
} from "./core-utils.js";
import {
  normalizeCustomerName,
  normalizeIsraeliPhone,
  normalizeServiceAddress
} from "./v2-normalization.js";

@Injectable()
export class CoreV2CustomersService {
  constructor(
    @Inject(CoreAccessService) private readonly access: CoreAccessService,
    @Inject(CoreV2IdempotencyService) private readonly idempotency: CoreV2IdempotencyService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(V2CustomersRepository) private readonly customers: V2CustomersRepository,
    @Inject(V2CustomerPhonesRepository) private readonly phones: V2CustomerPhonesRepository,
    @Inject(V2ServiceAddressesRepository) private readonly addresses: V2ServiceAddressesRepository
  ) {}

  async createCustomer(headers: RequestHeaders, businessId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2CreateCustomerSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: "v2.customer.create",
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: async () => {
        const customer = await this.customers.create({
          businessId,
          name: command.name,
          normalizedName: normalizeCustomerName(command.name),
          email: command.email?.toLocaleLowerCase(),
          generalNotes: command.generalNotes
        });
        await this.recordAudit(businessId, user.id, customer.id, "CREATE_V2_CUSTOMER", customer);
        return { customer };
      }
    });
  }

  async listCustomers(headers: RequestHeaders, businessId: string, query: unknown) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const pagination = paginationFromQuery(query);
    const page = paginatedResponse(await this.customers.list(businessId, pagination), pagination.limit);
    return { customers: page.items, pageInfo: page.pageInfo };
  }

  async getCustomer(headers: RequestHeaders, businessId: string, customerId: string) {
    await this.access.requireV2BusinessAccess(headers, businessId);
    const customer = await this.customers.findById(businessId, customerId);
    if (!customer) throw new NotFoundException("Customer not found");
    return { customer };
  }

  async updateCustomer(headers: RequestHeaders, businessId: string, customerId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2UpdateCustomerSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.customer.update.${customerId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: async () => {
        const customer = await this.customers.update({
          businessId,
          customerId,
          name: command.name,
          normalizedName: command.name ? normalizeCustomerName(command.name) : undefined,
          email: command.email?.toLocaleLowerCase() ?? command.email,
          generalNotes: command.generalNotes,
          version: command.version
        });
        if (!customer) await this.throwCustomerUpdateFailure(businessId, customerId, command.version);
        await this.recordAudit(businessId, user.id, customer!.id, "UPDATE_V2_CUSTOMER", customer!);
        return { customer: customer! };
      }
    });
  }

  async createPhone(headers: RequestHeaders, businessId: string, customerId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2CreateCustomerPhoneSchema.parse(body);
    const normalizedPhone = this.requiredNormalizedPhone(command.phone);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.customer.phone.create.${customerId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: async () => {
        await this.ensurePhoneAvailable(businessId, normalizedPhone);
        const phone = await this.phones.create({
          businessId,
          customerId,
          rawPhone: command.phone,
          normalizedPhone,
          label: command.label,
          isPrimary: command.isPrimary
        });
        if (!phone) throw new NotFoundException("Customer not found");
        await this.recordAudit(businessId, user.id, phone.id, "CREATE_V2_CUSTOMER_PHONE", phone);
        return { phone };
      }
    });
  }

  async updatePhone(headers: RequestHeaders, businessId: string, customerId: string, phoneId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2UpdateCustomerPhoneSchema.parse(body);
    const normalizedPhone = command.phone ? this.requiredNormalizedPhone(command.phone) : undefined;
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.customer.phone.update.${phoneId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: async () => {
        if (normalizedPhone) await this.ensurePhoneAvailable(businessId, normalizedPhone, phoneId);
        const phone = await this.phones.update({
          businessId,
          customerId,
          phoneId,
          rawPhone: command.phone,
          normalizedPhone,
          label: command.label,
          isPrimary: command.isPrimary
        });
        if (!phone) throw new NotFoundException("Customer phone not found");
        await this.recordAudit(businessId, user.id, phone.id, "UPDATE_V2_CUSTOMER_PHONE", phone);
        return { phone };
      }
    });
  }

  async deletePhone(headers: RequestHeaders, businessId: string, customerId: string, phoneId: string) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.customer.phone.delete.${phoneId}`,
      key: requiredIdempotencyKey(headers),
      request: { customerId, phoneId },
      execute: async () => {
        const phone = await this.phones.softDelete({ businessId, customerId, phoneId, deletedByUserId: user.id });
        if (!phone) throw new NotFoundException("Customer phone not found");
        await this.recordAudit(businessId, user.id, phone.id, "DELETE_V2_CUSTOMER_PHONE", phone);
        return { phone };
      }
    });
  }

  async createAddress(headers: RequestHeaders, businessId: string, customerId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2CreateServiceAddressSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.customer.address.create.${customerId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: async () => {
        const address = await this.addresses.create({
          businessId,
          customerId,
          label: command.label,
          addressText: command.addressText,
          normalizedAddress: normalizeServiceAddress(command.addressText)
        });
        if (!address) throw new NotFoundException("Customer not found");
        await this.recordAudit(businessId, user.id, address.id, "CREATE_V2_SERVICE_ADDRESS", address);
        return { address };
      }
    });
  }

  async updateAddress(headers: RequestHeaders, businessId: string, customerId: string, addressId: string, body: unknown) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    const command = V2UpdateServiceAddressSchema.parse(body);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.customer.address.update.${addressId}`,
      key: requiredIdempotencyKey(headers),
      request: command,
      execute: async () => {
        const address = await this.addresses.update({
          businessId,
          customerId,
          addressId,
          label: command.label,
          addressText: command.addressText,
          normalizedAddress: command.addressText ? normalizeServiceAddress(command.addressText) : undefined
        });
        if (!address) throw new NotFoundException("Service address not found");
        await this.recordAudit(businessId, user.id, address.id, "UPDATE_V2_SERVICE_ADDRESS", address);
        return { address };
      }
    });
  }

  async deleteAddress(headers: RequestHeaders, businessId: string, customerId: string, addressId: string) {
    const user = await this.access.requireV2BusinessAccess(headers, businessId);
    return this.idempotency.execute({
      businessId,
      userId: user.id,
      scope: `v2.customer.address.delete.${addressId}`,
      key: requiredIdempotencyKey(headers),
      request: { customerId, addressId },
      execute: async () => {
        const address = await this.addresses.softDelete({ businessId, customerId, addressId, deletedByUserId: user.id });
        if (!address) throw new NotFoundException("Service address not found");
        await this.recordAudit(businessId, user.id, address.id, "DELETE_V2_SERVICE_ADDRESS", address);
        return { address };
      }
    });
  }

  private requiredNormalizedPhone(value: string) {
    const normalized = normalizeIsraeliPhone(value);
    if (!normalized) throw new BadRequestException("Invalid Israeli phone number");
    return normalized;
  }

  private async ensurePhoneAvailable(businessId: string, normalizedPhone: string, currentPhoneId?: string) {
    const duplicate = await this.phones.findActiveByNormalizedPhone(businessId, normalizedPhone);
    if (duplicate && duplicate.id !== currentPhoneId) {
      throw new ConflictException({
        code: "PHONE_ALREADY_ASSIGNED",
        message: "Phone number is already assigned to another active customer",
        customer: { id: duplicate.customer.id, name: duplicate.customer.name }
      });
    }
  }

  private async throwCustomerUpdateFailure(businessId: string, customerId: string, version?: number): Promise<never> {
    const existing = await this.customers.findById(businessId, customerId);
    if (existing && version !== undefined) {
      throw new ConflictException({ code: "ENTITY_VERSION_CONFLICT", message: "Customer changed since it was loaded" });
    }
    throw new NotFoundException("Customer not found");
  }

  private recordAudit(businessId: string, actorId: string, entityId: string, action: string, after: unknown) {
    return this.audit.record({
      businessId,
      actorType: "user",
      actorId,
      source: "core_v2",
      entityType: "v2_crm",
      entityId,
      action,
      after: after as Prisma.InputJsonValue
    });
  }
}
