// Shared logic for writing an RSVP and its status-specific child rows.
export async function writeRsvp(c, memberId, rsvp) {
  const { rows: [r] } = await c.query(
    `INSERT INTO rsvps (member_id, status) VALUES ($1,$2)
     ON CONFLICT (member_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
     RETURNING id, manage_token`, [memberId, rsvp.status]);

  // Clear whichever branch no longer applies, so a MAYBE -> YES change leaves no stale rows
  await c.query('DELETE FROM rsvp_attendance WHERE rsvp_id=$1', [r.id]);
  await c.query('DELETE FROM rsvp_declines WHERE rsvp_id=$1', [r.id]);
  await c.query(`UPDATE rsvp_followups SET status='DONE', done_at=now() WHERE rsvp_id=$1 AND status='PENDING'`, [r.id]);

  if (rsvp.status === 'YES') {
    const a = rsvp.attendance;
    await c.query(
      `INSERT INTO rsvp_attendance (rsvp_id, companions_count, arrival_date, arrival_time, departure_date,
         travel_method, needs_accommodation, additional_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.id, a.companions_count, a.arrival_date, a.arrival_time, a.departure_date, a.travel_method,
       a.needs_accommodation, a.additional_info]);
  } else if (rsvp.status === 'MAYBE') {
    await c.query('INSERT INTO rsvp_followups (rsvp_id, remind_on) VALUES ($1,$2)', [r.id, rsvp.followup_date]);
  } else {
    if (rsvp.decline.reason_code === 'OTHER' && !rsvp.decline.reason_text) {
      const e = new Error('Please explain your reason'); e.status = 400; throw e;
    }
    await c.query('INSERT INTO rsvp_declines (rsvp_id, reason_code, reason_text) VALUES ($1,$2,$3)',
      [r.id, rsvp.decline.reason_code, rsvp.decline.reason_text]);
  }
  return r;
}
