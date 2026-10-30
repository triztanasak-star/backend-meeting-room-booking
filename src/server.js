const app = require('./app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const { flush } = require('./services/meetingMail');
const meetingMailTimer = setInterval(flush, 60000);
meetingMailTimer.unref();
