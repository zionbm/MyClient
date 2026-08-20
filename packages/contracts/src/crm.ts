import { z } from "zod";
import { CallbackTaskPrioritySchema } from "./actions.js";

const OptionalNonEmptyStringSchema = z.string().trim().min(1).optional();

export const CreateCustomerSchema = z.object({
  name: z.string().trim().min(1),
  phone: OptionalNonEmptyStringSchema,
  email: OptionalNonEmptyStringSchema,
  address: OptionalNonEmptyStringSchema
});

export type CreateCustomer = z.infer<typeof CreateCustomerSchema>;

export const UpdateCustomerSchema = CreateCustomerSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one customer field is required"
);

export type UpdateCustomer = z.infer<typeof UpdateCustomerSchema>;

export const CreateTaskSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: z.string().trim().min(1),
  description: OptionalNonEmptyStringSchema,
  priority: CallbackTaskPrioritySchema.default("NORMAL"),
  dueAt: OptionalNonEmptyStringSchema
});

export type CreateTask = z.infer<typeof CreateTaskSchema>;

export const UpdateTaskSchema = z.object({
  customerId: OptionalNonEmptyStringSchema,
  title: OptionalNonEmptyStringSchema,
  description: OptionalNonEmptyStringSchema,
  priority: CallbackTaskPrioritySchema.optional(),
  dueAt: z.string().trim().min(1).nullable().optional(),
  status: z.enum(["OPEN", "COMPLETED", "CANCELLED"]).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one task field is required");

export type UpdateTask = z.infer<typeof UpdateTaskSchema>;

export const CreateCustomerNoteSchema = z.object({
  text: z.string().trim().min(1)
});

export type CreateCustomerNote = z.infer<typeof CreateCustomerNoteSchema>;
