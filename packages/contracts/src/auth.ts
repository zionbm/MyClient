import { z } from "zod";

export const RegisterBusinessSchema = z.object({
  firebaseUid: z.string().trim().min(1),
  email: z.string().trim().email(),
  displayName: z.string().trim().min(1),
  businessName: z.string().trim().min(1)
});

export type RegisterBusiness = z.infer<typeof RegisterBusinessSchema>;

export const AuthMeQuerySchema = z.object({
  firebaseUid: z.string().trim().min(1)
});

export type AuthMeQuery = z.infer<typeof AuthMeQuerySchema>;
