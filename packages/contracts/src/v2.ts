import { z } from "zod";

export const ProductModelVersionSchema = z.union([z.literal(1), z.literal(2)]);
export type ProductModelVersion = z.infer<typeof ProductModelVersionSchema>;

export const V2CapabilitiesSchema = z.object({
  productModelVersion: ProductModelVersionSchema,
  v2Api: z.boolean(),
  v2Assistant: z.boolean()
});
export type V2Capabilities = z.infer<typeof V2CapabilitiesSchema>;

export function capabilitiesForProductModelVersion(productModelVersion: number): V2Capabilities {
  const normalizedVersion: ProductModelVersion = productModelVersion >= 2 ? 2 : 1;
  return {
    productModelVersion: normalizedVersion,
    v2Api: normalizedVersion === 2,
    v2Assistant: normalizedVersion === 2
  };
}

export const V2TaskStatusSchema = z.enum(["OPEN", "DONE", "CANCELLED"]);
export type V2TaskStatus = z.infer<typeof V2TaskStatusSchema>;

export const V2ActivityStatusSchema = z.enum(["OPEN", "CLOSED", "CANCELLED"]);
export type V2ActivityStatus = z.infer<typeof V2ActivityStatusSchema>;

export const V2PaymentStatusSchema = z.enum(["UNPAID", "PARTIALLY_PAID", "PAID"]);
export type V2PaymentStatus = z.infer<typeof V2PaymentStatusSchema>;

export const V2AmountEventTypeSchema = z.enum([
  "CREATE",
  "ADD_PAYMENT",
  "SET_PAID_TOTAL",
  "SETTLE_BALANCE",
  "CHANGE_TOTAL",
  "CORRECTION",
  "UNDO"
]);
export type V2AmountEventType = z.infer<typeof V2AmountEventTypeSchema>;

export const V2PaymentModeSchema = z.enum(["ADD", "SET_PAID_TOTAL", "SETTLE_BALANCE"]);
export type V2PaymentMode = z.infer<typeof V2PaymentModeSchema>;

export const V2PendingStatusSchema = z.enum(["PENDING", "COMPLETED", "REJECTED"]);
export type V2PendingStatus = z.infer<typeof V2PendingStatusSchema>;

export const V2ActionBatchStatusSchema = z.enum([
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "WAITING",
  "FAILED",
  "UNDONE"
]);
export type V2ActionBatchStatus = z.infer<typeof V2ActionBatchStatusSchema>;

export const AssistantResponseModeSchema = z.enum(["TEXT_ONLY", "TEXT_AND_VOICE"]);
export type AssistantResponseMode = z.infer<typeof AssistantResponseModeSchema>;

export const V2CurrencySchema = z.literal("ILS");
export type V2Currency = z.infer<typeof V2CurrencySchema>;

export const V2MoneySchema = z.coerce.number().finite().min(0).multipleOf(0.01);
export type V2Money = z.infer<typeof V2MoneySchema>;

export const V2PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional()
});
export type V2PaginationQuery = z.infer<typeof V2PaginationQuerySchema>;

export const IdempotencyKeySchema = z.string().trim().min(1).max(200);
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const V2EntityVersionSchema = z.number().int().positive();
export type V2EntityVersion = z.infer<typeof V2EntityVersionSchema>;

const OptionalTrimmedStringSchema = z.string().trim().min(1).optional();
const NullableTrimmedStringSchema = z.string().trim().min(1).nullable().optional();
const OptionalIsoDateSchema = z.string().datetime({ offset: true }).optional();
const NullableIsoDateSchema = z.string().datetime({ offset: true }).nullable().optional();

export const V2CreateCustomerSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email().optional(),
  generalNotes: OptionalTrimmedStringSchema
});
export type V2CreateCustomer = z.infer<typeof V2CreateCustomerSchema>;

export const V2UpdateCustomerSchema = z.object({
  name: OptionalTrimmedStringSchema,
  email: z.string().trim().email().nullable().optional(),
  generalNotes: NullableTrimmedStringSchema,
  version: V2EntityVersionSchema.optional()
}).refine((value) => Object.keys(value).some((key) => key !== "version"), {
  message: "At least one customer field is required"
});
export type V2UpdateCustomer = z.infer<typeof V2UpdateCustomerSchema>;

export const V2CreateCustomerPhoneSchema = z.object({
  phone: z.string().trim().min(1),
  label: OptionalTrimmedStringSchema,
  isPrimary: z.boolean().optional()
});
export type V2CreateCustomerPhone = z.infer<typeof V2CreateCustomerPhoneSchema>;

export const V2UpdateCustomerPhoneSchema = z.object({
  phone: OptionalTrimmedStringSchema,
  label: NullableTrimmedStringSchema,
  isPrimary: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one phone field is required"
});
export type V2UpdateCustomerPhone = z.infer<typeof V2UpdateCustomerPhoneSchema>;

export const V2CreateServiceAddressSchema = z.object({
  label: OptionalTrimmedStringSchema,
  addressText: z.string().trim().min(1)
});
export type V2CreateServiceAddress = z.infer<typeof V2CreateServiceAddressSchema>;

export const V2UpdateServiceAddressSchema = z.object({
  label: NullableTrimmedStringSchema,
  addressText: OptionalTrimmedStringSchema
}).refine((value) => Object.keys(value).length > 0, {
  message: "At least one address field is required"
});
export type V2UpdateServiceAddress = z.infer<typeof V2UpdateServiceAddressSchema>;

export const V2CreateTaskSchema = z.object({
  customerId: OptionalTrimmedStringSchema,
  title: z.string().trim().min(1),
  description: OptionalTrimmedStringSchema,
  dueAt: OptionalIsoDateSchema,
  status: V2TaskStatusSchema.optional()
});
export type V2CreateTask = z.infer<typeof V2CreateTaskSchema>;

export const V2UpdateTaskSchema = z.object({
  customerId: z.string().trim().min(1).nullable().optional(),
  title: OptionalTrimmedStringSchema,
  description: NullableTrimmedStringSchema,
  dueAt: NullableIsoDateSchema,
  status: V2TaskStatusSchema.optional(),
  version: V2EntityVersionSchema.optional()
}).refine((value) => Object.keys(value).some((key) => key !== "version"), {
  message: "At least one task field is required"
});
export type V2UpdateTask = z.infer<typeof V2UpdateTaskSchema>;
