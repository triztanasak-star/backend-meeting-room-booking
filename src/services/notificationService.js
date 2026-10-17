// NotificationService
// Chịu trách nhiệm gửi thông báo Microsoft Teams (qua Power Automate Workflow) và Email (qua SMTP)
// cho các sự kiện trong luồng dự án:
//   - Khi tạo dự án (request)      -> thông báo cho Manager
//   - Khi duyệt dự án (approved)   -> thông báo cho PIC/Support
//
// QUAN TRỌNG: Mọi biến môi trường được đọc BÊN TRONG function (lazy read),
// KHÔNG đọc ở top-level, để đảm bảo dotenv đã nạp xong trước khi dùng.
// Xem các biến cần điền tại backend/.env.example (mục "=== NOTIFICATIONS ===").

const nodemailer = require('nodemailer');

// --- Helper đọc env lazy (mỗi lần gọi đều lấy giá trị mới nhất) ---

const getTeamsWebhookUrl = () => process.env.TEAMS_WEBHOOK_URL || '';
const getAppUrl = () => process.env.APP_URL || 'https://digitalcpvn.vercel.app';

const getSmtpConfig = () => ({
  host: process.env.SMTP_HOST || '',
  port: Number.parseInt(process.env.SMTP_PORT, 10) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
});

const getManagerEmails = () =>
  (process.env.MANAGER_NOTIFY_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

let cachedTransporter = null;
let cachedTransporterKey = null;

// Lazy-init transporter: chỉ tạo khi đã có đủ cấu hình SMTP, và cache theo config
function getTransporter() {
  const cfg = getSmtpConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) return null;

  const cacheKey = `${cfg.host}|${cfg.port}|${cfg.user}`;
  if (cachedTransporter && cachedTransporterKey === cacheKey) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  cachedTransporterKey = cacheKey;
  return cachedTransporter;
}

// Dựng Adaptive Card + bọc trong "attachments" theo schema Power Automate
// (action "Post card in a chat or channel" yêu cầu content có "type": "AdaptiveCard").
function buildAdaptiveCardPayload(title, text, url) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: title,
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
            },
            {
              type: 'TextBlock',
              text,
              wrap: true,
            },
          ],
          actions: url
            ? [
                {
                  type: 'Action.OpenUrl',
                  title: 'Mở hệ thống Digital Work',
                  url,
                },
              ]
            : [],
        },
      },
    ],
  };
}

// Gửi message sang Microsoft Teams qua Power Automate Workflow webhook
async function sendTeamsMessage(title, text, url = null) {
  const webhookUrl = getTeamsWebhookUrl();

  if (!webhookUrl) {
    console.warn('[NotificationService] Thiếu TEAMS_WEBHOOK_URL — bỏ qua gửi Teams.');
    return { skipped: true, reason: 'missing-webhook' };
  }

  const appUrl = url || getAppUrl();

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAdaptiveCardPayload(title, text, appUrl)),
    });

    const responseBody = await response.text().catch(() => '');

    if (!response.ok) {
      console.error(
        `[NotificationService] Teams webhook status ${response.status}:`,
        responseBody.substring(0, 500),
      );
      return { ok: false, status: response.status, body: responseBody };
    }

    console.log(`[NotificationService] Đã gửi Teams (status ${response.status}):`, title);
    return { ok: true, status: response.status };
  } catch (error) {
    console.error('[NotificationService] Gửi Teams thất bại:', error);
    return { ok: false, error: error.message };
  }
}

// Gửi email qua SMTP. `to` có thể là 1 email hoặc danh sách email.
async function sendEmail(to, subject, html) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) {
    console.warn('[NotificationService] Không có người nhận email — bỏ qua.', { subject });
    return { skipped: true, reason: 'no-recipients' };
  }

  const transporter = getTransporter();
  if (!transporter) {
    console.warn('[NotificationService] Thiếu cấu hình SMTP — bỏ qua gửi mail.', { subject });
    return { skipped: true, reason: 'missing-smtp' };
  }

  try {
    const info = await transporter.sendMail({
      from: getSmtpConfig().from,
      to: recipients.join(','),
      subject,
      html,
    });
    console.log('[NotificationService] Đã gửi email:', info.messageId || '(no id)');
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error('[NotificationService] Gửi email thất bại:', error);
    return { ok: false, error: error.message };
  }
}

// --- Các sự kiện nghiệp vụ ---

async function notifyWorkCreated(work) {
  const appUrl = getAppUrl();
  const title = `📋 Yêu cầu dự án mới: ${work.task_name}`;
  const text = [
    `Dự án: ${work.task_name}`,
    `Nhà máy: ${work.factory_name || '—'}`,
    `Người tạo (ID): ${work.created_by ?? '—'}`,
    'Trạng thái: Yêu cầu — đang chờ duyệt.',
  ].join('\n');

  await Promise.all([
    sendTeamsMessage(title, text, appUrl),
    sendEmail(
      getManagerEmails(),
      title,
      `<p><b>Dự án:</b> ${work.task_name}</p>
       <p><b>Nhà máy:</b> ${work.factory_name || '—'}</p>
       <p>Dự án vừa được tạo và đang chờ duyệt.</p>
       <p><a href="${appUrl}" target="_blank" rel="noopener noreferrer">Mở hệ thống Digital Work</a></p>`,
    ),
  ]);
}

async function notifyWorkApproved(work, recipientEmails = []) {
  const appUrl = getAppUrl();
  const title = `✅ Dự án đã được duyệt: ${work.task_name}`;
  const text = [
    `Dự án: ${work.task_name}`,
    `PIC: ${work.lead_project || '—'}`,
    `Support: ${work.assistant || '—'}`,
    'Trạng thái: Đã duyệt — vui lòng chấp nhận và bắt đầu thực hiện.',
  ].join('\n');

  await Promise.all([
    sendTeamsMessage(title, text, appUrl),
    sendEmail(
      recipientEmails,
      title,
      `<p><b>Dự án:</b> ${work.task_name}</p>
       <p><b>PIC:</b> ${work.lead_project || '—'} — <b>Support:</b> ${work.assistant || '—'}</p>
       <p>Dự án đã được duyệt, vui lòng vào hệ thống để chấp nhận và cập nhật tiến độ.</p>
       <p><a href="${appUrl}" target="_blank" rel="noopener noreferrer">Mở hệ thống Digital Work</a></p>`,
    ),
  ]);
}

async function notifyWorkRejected(work) {
  return sendTeamsMessage(
    `Không duyệt dự án: ${work.task_name}`,
    [
      `Dự án: ${work.task_name}`,
      `Nhà máy: ${work.factory_name || '—'}`,
      'Trạng thái: Không duyệt',
      `Lý do: ${work.rejection_reason}`,
    ].join('\n'),
    getAppUrl(),
  );
}

async function notifyWorkInProgress(work) {
  const appUrl = getAppUrl();
  const title = `🚀 Dự án bắt đầu thực hiện: ${work.task_name}`;
  const text = [
    `Dự án: ${work.task_name}`,
    `PIC: ${work.lead_project || '—'}`,
    `Support: ${work.assistant || '—'}`,
    'Trạng thái: Thực hiện — PIC đã chấp nhận và đang triển khai.',
  ].join('\n');

  await Promise.all([
    sendTeamsMessage(title, text, appUrl),
    sendEmail(
      getManagerEmails(),
      title,
      `<p><b>Dự án:</b> ${work.task_name}</p>
       <p><b>PIC:</b> ${work.lead_project || '—'} — <b>Support:</b> ${work.assistant || '—'}</p>
       <p>PIC đã chấp nhận và bắt đầu thực hiện dự án.</p>
       <p><a href="${appUrl}" target="_blank" rel="noopener noreferrer">Mở hệ thống Digital Work</a></p>`,
    ),
  ]);
}

async function notifyWorkCompleted(work) {
  const appUrl = getAppUrl();
  const title = `🎉 Dự án đã hoàn thành: ${work.task_name}`;
  const text = [
    `Dự án: ${work.task_name}`,
    `PIC: ${work.lead_project || '—'}`,
    `Support: ${work.assistant || '—'}`,
    'Trạng thái: Hoàn thành — tiến độ đã đạt 100%.',
  ].join('\n');

  await Promise.all([
    sendTeamsMessage(title, text, appUrl),
    sendEmail(
      getManagerEmails(),
      title,
      `<p><b>Dự án:</b> ${work.task_name}</p>
       <p><b>PIC:</b> ${work.lead_project || '—'} — <b>Support:</b> ${work.assistant || '—'}</p>
       <p>Dự án đã hoàn thành (tiến độ 100%).</p>
       <p><a href="${appUrl}" target="_blank" rel="noopener noreferrer">Mở hệ thống Digital Work</a></p>`,
    ),
  ]);
}

// Test gửi email (dùng cho route /api/test-email)
async function sendTestEmail() {
  const to = getManagerEmails();
  if (to.length === 0) {
    return { skipped: true, reason: 'no-manager-emails' };
  }
  return sendEmail(
    to,
    '[Digital Work] Test email từ Render',
    '<p>Đây là email test từ NotificationService.</p>',
  );
}

module.exports = {
  sendTeamsMessage,
  sendEmail,
  sendTestEmail,
  notifyWorkCreated,
  notifyWorkApproved,
  notifyWorkRejected,
  notifyWorkInProgress,
  notifyWorkCompleted,
};