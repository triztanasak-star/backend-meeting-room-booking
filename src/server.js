const app = require('./app');
const https = require('node:https');

const SERVER_URL = 'https://backend-meeting-room-booking.onrender.com/api/health';

const isWorkingHourVN = () => {
  const nowVN = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })
  );
  const day = nowVN.getDay(); // 0: Chủ Nhật, 1..5: Thứ 2..Thứ 6, 6: Thứ 7
  const hour = nowVN.getHours(); // 0..23

  // Chỉ ping từ Thứ 2 đến Thứ 6, khung 08:00 - 16:59 giờ VN
  return day >= 1 && day <= 5 && hour >= 8 && hour < 17;
};

const pingServer = () => {
  if (!isWorkingHourVN()) return;

  const request = https.get(SERVER_URL, { timeout: 30_000 }, (res) => {
    res.resume();
    console.log(`[Keep-Alive] Ping sent. Status Code: ${res.statusCode}`);
  });

  request.on('timeout', () => {
    request.destroy(new Error('Ping timed out after 30 seconds'));
  });
  request.on('error', (err) => {
    console.error('[Keep-Alive] Ping error:', err.message);
  });
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  const keepAliveTimer = setInterval(pingServer, 14 * 60 * 1000);
  keepAliveTimer.unref();
});

const { flush } = require('./services/meetingMail');
const meetingMailTimer = setInterval(flush, 60000);
meetingMailTimer.unref();