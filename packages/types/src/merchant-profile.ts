import { z } from "zod";

export const MerchantProfileUpdateSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    description: z.string().max(1000).optional(),
    supportEmail: z.string().email().optional(),
    webhookUrl: z.string().url().optional(),
  })
  .strict()
  .refine((profile) => Object.keys(profile).length > 0, {
    message: "At least one profile field must be provided",
  });
