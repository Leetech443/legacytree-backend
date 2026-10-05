import { z } from 'zod';

const todayISO = () => new Date().toISOString().slice(0, 10);
const text = (max) => z.string().trim().max(max).optional().transform((v) => v || null);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date');

export const attendanceSchema = z.object({ arrival_date: isoDate });

export const rsvpSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('YES'), attendance: attendanceSchema }),
  z.object({
    status: z.literal('MAYBE'),
    followup_date: isoDate.refine((d) => d > todayISO(), 'Pick a future date'),
  }),
  z.object({
    status: z.literal('NO'),
    decline: z.object({ reason_code: z.string().min(1), reason_text: text(1000) }),
  }),
]);

export const memberSchema = z.object({
  full_name: z.string().trim().min(2).max(200),
  generation: z.enum(['CHILD', 'GRANDCHILD', 'GREAT_GRANDCHILD']),
  gender: z.enum(['Male', 'Female']),
  parent_id: z.coerce.number().int().positive(),
  lineage_side: z.enum(['Maternal', 'Paternal']).optional(),
  has_children: z.boolean().default(false),
  email: z.string().trim().email().max(255).optional().or(z.literal('')).transform((v) => v || null), // optional everywhere
  phone: text(50),
  age: z.coerce.number().int().min(0).max(120).optional(),
  occupation: text(120),
  marital_status: z.enum(['Single', 'Married', 'Divorced', 'Widowed']).optional(),
  spouses: z.array(z.string().trim().min(1, 'Name is required').max(200)).max(10).optional(), // wives (men) or husband (women)
  parent_spouse_id: z.coerce.number().int().positive().optional(), // which wife of the father is my mother
  guardian_name: text(200),
  guardian_phone: text(50),
}).superRefine((m, ctx) => {
  const need = (k, msg = 'Required') => { if (!m[k]) ctx.addIssue({ code: 'custom', path: [k], message: msg }); };
  if (m.generation === 'CHILD') { need('phone'); need('occupation'); need('marital_status'); }
  if (m.generation === 'GRANDCHILD') { need('age'); need('lineage_side'); need('occupation'); need('marital_status'); }
  if (m.generation === 'GREAT_GRANDCHILD') { need('age'); need('lineage_side'); need('guardian_name'); need('guardian_phone'); }
  if (m.generation !== 'GREAT_GRANDCHILD' && m.marital_status === 'Married') {
    const n = m.spouses?.length || 0;
    if (n < 1) ctx.addIssue({ code: 'custom', path: ['spouses'], message: "Spouse's name is required" });
    if (m.gender === 'Female' && n > 1) ctx.addIssue({ code: 'custom', path: ['spouses'], message: 'Only one husband can be entered' });
  }
});

export const registerSchema = z.object({
  member: memberSchema,
  rsvp: rsvpSchema,
  consent: z.literal(true, { errorMap: () => ({ message: 'Consent is required' }) }),
});

// Family mothers: always female, so no gender field
export const parentSchema = z.object({
  full_name: z.string().trim().min(2).max(200),
  phone: text(50),
  email: z.string().trim().email().optional().or(z.literal('')).transform((v) => v || null),
});
