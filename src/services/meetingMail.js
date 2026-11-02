const nodemailer = require("nodemailer");
const db = require("../db");
const { sendTeamsMessage } = require("./notificationService");
let running = false;
async function flush() {
  if (running) return;
  running = true;
  try {
    if (process.env.TEAMS_WEBHOOK_URL) {
      for (const table of ["meeting_teams_outbox", "vehicle_teams_outbox"]) await db.withTransaction(async (c) => {
        const { rows } = await c.query(
          `SELECT * FROM ${table} WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED`,
        );
        for (const message of rows) {
          const result = await sendTeamsMessage(message.subject, message.body);
          if (result.ok) {
            await c.query(
              `UPDATE ${table} SET sent_at=NOW(),attempts=attempts+1,last_error=NULL WHERE id=$1`,
              [message.id],
            );
          } else {
            await c.query(
              `UPDATE ${table} SET attempts=attempts+1,last_error=$2 WHERE id=$1`,
              [message.id, String(result.error || result.body || result.reason || `HTTP ${result.status}`).slice(0, 500)],
            );
          }
        }
      }).catch((e) => console.error("[meeting-teams]", e.message));
    }
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    if (!process.env.SMTP_HOST || !from) return;
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS || process.env.SMTP_PASSWORD,
          }
        : undefined,
    });
    for (const table of ["meeting_email_outbox", "vehicle_email_outbox"]) await db.withTransaction(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM ${table} WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED`,
      );
      for (const mail of rows) {
        try {
          await transport.sendMail({
            from,
            to: mail.recipients.join(","),
            subject: mail.subject,
            text: mail.body,
          });
          await c.query(
            `UPDATE ${table} SET sent_at=NOW(),attempts=attempts+1,last_error=NULL WHERE id=$1`,
            [mail.id],
          );
        } catch (e) {
          await c.query(
            `UPDATE ${table} SET attempts=attempts+1,last_error=$2 WHERE id=$1`,
            [mail.id, String(e.message).slice(0, 500)],
          );
        }
      }
    });
  } catch (e) {
    console.error("[meeting-mail]", e.message);
  } finally {
    running = false;
  }
}
module.exports = { flush };
