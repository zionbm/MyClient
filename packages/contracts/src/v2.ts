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
