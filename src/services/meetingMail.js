const nodemailer = require("nodemailer");
const db = require("../db");
let running = false;
async function flush() {
  if (running || !process.env.SMTP_HOST || !process.env.SMTP_FROM) return;
  running = true;
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS || process.env.SMTP_PASSWORD,
          }
        : undefined,
    });
    await db.withTransaction(async (c) => {
      const { rows } = await c.query(
        "SELECT * FROM meeting_email_outbox WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED",
      );
      for (const mail of rows) {
        try {
          await transport.sendMail({
            from: process.env.SMTP_FROM,
            to: mail.recipients.join(","),
            subject: mail.subject,
            text: mail.body,
          });
          await c.query(
            "UPDATE meeting_email_outbox SET sent_at=NOW(),attempts=attempts+1,last_error=NULL WHERE id=$1",
            [mail.id],
          );
        } catch (e) {
          await c.query(
            "UPDATE meeting_email_outbox SET attempts=attempts+1,last_error=$2 WHERE id=$1",
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
