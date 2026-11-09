const app = require('./app');
const https = require('node:https');

const SERVER_URL = 'https://backend-meeting-room-booking.onrender.com/api/health';

const pingServer = () => {
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
