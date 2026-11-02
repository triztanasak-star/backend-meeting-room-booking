// Enqueue in the booking transaction; the shared worker delivers after commit.
async function notifyVehicle(c, b) {
  const labels = { pending: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Từ chối', cancelled: 'Đã hủy' };
  const { rows } = await c.query(
    "SELECT email FROM users WHERE id=$1 OR role='admin' OR id IN (SELECT user_id FROM vehicle_approvers)",
    [b.created_by],
  );
  const assignments = (await c.query(
    'SELECT v.plate,v.name,d.name AS driver_name,d.phone AS driver_phone FROM vehicle_assignments a JOIN vehicle_fleet v ON v.id=a.vehicle_id JOIN vehicle_drivers d ON d.id=a.driver_id WHERE a.booking_id=$1',
    [b.id],
  )).rows;
  const subject = `Đặt xe #${b.id} · ${labels[b.status]}`;
  const body = [
    subject,
    `Ngày: ${b.booking_date instanceof Date ? b.booking_date.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) : b.booking_date}`,
    `Khởi hành: ${b.departure_point} · ${b.departure_time}`,
    `Điểm đến: ${b.destination}`,
    `Số xe: ${b.quantity}`,
    `Mục đích: ${b.purpose}`,
    `Điện thoại: ${b.phone}`,
    ...assignments.map(a => `Xe: ${a.name} (${a.plate}) · Tài xế: ${a.driver_name} · ${a.driver_phone}`),
    ...(b.reason ? [`Lý do: ${b.reason}`] : []),
  ].join('\n');
  await c.query('INSERT INTO vehicle_teams_outbox(booking_id,subject,body) VALUES ($1,$2,$3)', [b.id, subject, body]);
  const recipients = [...new Set(rows.map(u => u.email).filter(Boolean))];
  if (recipients.length) await c.query(
    'INSERT INTO vehicle_email_outbox(booking_id,recipients,subject,body) VALUES ($1,$2,$3,$4)',
    [b.id, recipients, subject, body],
  );
}
module.exports = { notifyVehicle };
