import { z } from 'zod';

const todayISO = () => new Date().toISOString().slice(0, 10);
const text = (max) => z.string().trim().max(max).optional().transform((v) => v || null);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date');

export const attendanceSchema = z.object({
  companions_count: z.coerce.number().int().min(0).max(50).default(0),
  arrival_date: isoDate,
  arrival_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time'),
  departure_date: isoDate,
  travel_method: z.string().min(1),
  needs_accommodation: z.boolean(),
  additional_info: text(2000),
}).refine((a) => a.departure_date >= a.arrival_date, { path: ['departure_date'], message: 'Departure must be on/after arrival' });

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
  email: z.string().trim().email().max(255).optional().or(z.literal('')).transform((v) => v || null),
  phone: text(50),
  age: z.coerce.number().int().min(0).max(120).optional(),
  school: text(200),
  guardian_name: text(200),
  guardian_phone: text(50),
}).superRefine((m, ctx) => {
  const need = (k) => { if (!m[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'Required' }); };
  if (m.generation === 'CHILD') { need('email'); need('phone'); }
  if (m.generation === 'GRANDCHILD') { need('age'); need('lineage_side'); }
  if (m.generation === 'GREAT_GRANDCHILD') { need('age'); need('lineage_side'); need('guardian_name'); need('guardian_phone'); }
});

export const registerSchema = z.object({
  member: memberSchema,
  rsvp: rsvpSchema,
  consent: z.literal(true, { errorMap: () => ({ message: 'Consent is required' }) }),
});

export const parentSchema = z.object({
  full_name: z.string().trim().min(2).max(200),
  gender: z.enum(['Male', 'Female']),
  phone: text(50),
  email: z.string().trim().email().optional().or(z.literal('')).transform((v) => v || null),
});
