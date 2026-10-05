"use server";
import { Prisma } from "@prisma/client";
import { parse } from "csv-parse/sync";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { leadSchema, parseForm } from "@/lib/validation";

export type LeadFormState = { error?: string } | undefined;

export async function createLeadAction(_prev: LeadFormState, formData: FormData): Promise<LeadFormState> {
  const { tenantId } = await requireSession();

  const parsed = parseForm(leadSchema, formData);
  if (!parsed.success) return { error: parsed.error };
  const { name, phone, email, company } = parsed.data;

  await prisma.lead.create({
    data: { tenantId, name: name || null, phone: phone || null, email: email || null, company: company || null, status: "new", source: "manual" },
  });

  revalidatePath("/leads");
}

export async function updateLeadAction(leadId: string, formData: FormData) {
  const { tenantId } = await requireSession();

  await prisma.lead.updateMany({
    where: { id: leadId, tenantId },
    data: {
      name: String(formData.get("name") || "") || null,
      phone: String(formData.get("phone") || "") || null,
      email: String(formData.get("email") || "") || null,
      company: String(formData.get("company") || "") || null,
      status: String(formData.get("status") || "new"),
      tags: String(formData.get("tags") || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    },
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
}

export async function addLeadNoteAction(leadId: string, formData: FormData) {
  const { tenantId, email } = await requireSession();
  const text = String(formData.get("note") || "").trim();
  if (!text) return;

  const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId } });
  if (!lead) return;

  const notes = Array.isArray(lead.notes) ? lead.notes : [];
  notes.push({ author: email, text, createdAt: new Date().toISOString() });

  await prisma.lead.update({ where: { id: leadId }, data: { notes: notes as Prisma.InputJsonValue[] } });
  revalidatePath(`/leads/${leadId}`);
}

export async function deleteLeadAction(leadId: string): Promise<{ error?: string }> {
  const { tenantId } = await requireSession();

  const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId } });
  if (!lead) return { error: "Lead not found." };

  // Appointment.leadId is a required relation (Restrict on delete), so a
  // lead with a booked appointment can't be hard-deleted without orphaning
  // that record — block it with a clear message instead of a raw DB error.
  const appointmentCount = await prisma.appointment.count({ where: { leadId, tenantId } });
  if (appointmentCount > 0) {
    return { error: `This lead has ${appointmentCount} appointment(s) on record and can't be deleted. Cancel or reassign them first.` };
  }

  await prisma.lead.deleteMany({ where: { id: leadId, tenantId } });
  revalidatePath("/leads");
  return {};
}

/**
 * CSV import. Reuses the same column-detection idea as the existing
 * calling-engine repo's importer (match common header variants for name/
 * phone/email/company; anything else lands in custom_fields), rebuilt here
 * rather than pulled in directly since this is a fresh codebase — worth
 * diffing against the original if closer parity matters later.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  name: ["name", "full name", "fullname", "contact name"],
  phone: ["phone", "phone number", "mobile", "cell", "telephone"],
  email: ["email", "email address", "e-mail"],
  company: ["company", "company name", "organization", "org"],
};

function detectColumn(headers: string[], field: string): string | null {
  const aliases = HEADER_ALIASES[field];
  const normalized = headers.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return headers[idx];
  }
  return null;
}

export async function importLeadsCsvAction(formData: FormData) {
  const { tenantId } = await requireSession();

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) return { error: "No file uploaded." };

  const text = await file.text();
  let rows: Record<string, string>[];
  try {
    rows = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  } catch {
    return { error: "Could not parse that CSV. Check the formatting and try again." };
  }
  if (rows.length === 0) return { error: "That CSV has no rows." };

  const headers = Object.keys(rows[0]);
  const nameCol = detectColumn(headers, "name");
  const phoneCol = detectColumn(headers, "phone");
  const emailCol = detectColumn(headers, "email");
  const companyCol = detectColumn(headers, "company");
  const knownCols = new Set([nameCol, phoneCol, emailCol, companyCol].filter(Boolean));

  const toCreate = rows
    .map((row) => {
      const customFields: Record<string, string> = {};
      for (const h of headers) {
        if (!knownCols.has(h) && row[h]) customFields[h] = row[h];
      }
      return {
        tenantId,
        name: nameCol ? row[nameCol] || null : null,
        phone: phoneCol ? row[phoneCol] || null : null,
        email: emailCol ? row[emailCol] || null : null,
        company: companyCol ? row[companyCol] || null : null,
        customFields: Object.keys(customFields).length ? customFields : undefined,
        status: "new",
        source: "csv_import",
      };
    })
    .filter((l) => l.phone || l.email);

  if (toCreate.length === 0) {
    return { error: "No rows had a recognizable phone or email column." };
  }

  await prisma.lead.createMany({ data: toCreate });
  revalidatePath("/leads");
  return { imported: toCreate.length, skipped: rows.length - toCreate.length };
}
