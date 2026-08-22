import { z } from "zod";

export const RegisterBusinessSchema = z.object({
  firebaseUid: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  phoneNumber: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  businessName: z.string().trim().min(1)
});

export type RegisterBusiness = z.infer<typeof RegisterBusinessSchema>;
