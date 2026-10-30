const { fail, dayNumber, todayVN } = require('./bookingRules');
function validateRequest(b) {
  if (dayNumber(b.booking_date) < dayNumber(todayVN())) fail('Không thể đặt xe cho ngày đã qua.');
  if (!Number.isInteger(b.quantity) || b.quantity < 1 || b.quantity > 1000) fail('Số lượng xe phải từ 1 đến 1000.');
  for (const [key, max] of [['destination',500],['purpose',2000],['phone',30]]) {
    if (typeof b[key] !== 'string' || !b[key].trim() || b[key].length > max) fail('Vui lòng nhập đầy đủ điểm đến, mục đích và điện thoại đúng độ dài.');
  }
}
function validateAssignments(assignments, quantity) {
  if (!Array.isArray(assignments) || assignments.length !== quantity ||
      assignments.some(a => !a || !Number.isInteger(a.vehicle_id) || a.vehicle_id < 1 || !Number.isInteger(a.driver_id) || a.driver_id < 1) ||
      new Set(assignments.map(a => a.vehicle_id)).size !== quantity ||
      new Set(assignments.map(a => a.driver_id)).size !== quantity) fail('Phải chọn đủ xe và tài xế, không được trùng trong yêu cầu.');
}
module.exports = { validateRequest, validateAssignments };
