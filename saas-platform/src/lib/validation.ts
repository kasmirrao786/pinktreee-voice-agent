import { z } from "zod";

export const registerSchema = z.object({
  companyName: z.string().trim().min(1, "Company name is required.").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters.").max(200),
});

export const agentSchema = z.object({
  name: z.string().trim().min(1, "Agent name is required.").max(120),
  systemPrompt: z.string().trim().min(1, "System prompt is required."),
  description: z.string().trim().max(500).optional(),
  voiceId: z.string().optional(),
  llmModel: z.string().optional(),
  greetingMessage: z.string().max(2000).optional(),
  closingMessage: z.string().max(2000).optional(),
  transferNumber: z.string().max(30).optional(),
});

export const leadSchema = z
  .object({
    name: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(30).optional(),
    email: z.string().trim().toLowerCase().max(200).optional(),
    company: z.string().trim().max(200).optional(),
  })
  .refine((data) => Boolean(data.phone) || Boolean(data.email), {
    message: "A lead needs at least a phone number or an email address.",
  });

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  role: z.enum(["admin", "member"]),
});

/** Runs a zod schema against FormData and returns either the parsed data or a single readable error string. */
export function parseForm<T extends z.ZodTypeAny>(
  schema: T,
  formData: FormData
): { data: z.infer<T>; error?: undefined } | { data?: undefined; error: string } {
  const raw = Object.fromEntries(formData.entries());
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { error: result.error.issues[0]?.message || "Invalid input." };
  }
  return { data: result.data };
}
