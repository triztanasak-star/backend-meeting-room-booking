const fail = (message, status = 400) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
const todayVN = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const dayNumber = (date) => {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    fail("Ngày không hợp lệ.");
  const n = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== date)
    fail("Ngày không hợp lệ.");
  return n / 86400000;
};
const minutes = (time) => {
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    fail("Giờ không hợp lệ.");
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
};
function validateBooking(
  input,
  room,
  userFloor,
  today = todayVN(),
  existing = null,
) {
  const start = dayNumber(input.start_date),
    end = dayNumber(input.end_date),
    now = dayNumber(today);
  const auto = (room.is_default ?? room.level === 1) || Number(userFloor) === Number(room.floor_id);
  const days = auto ? 30 : 3;
  const unchangedStart =
    existing &&
    existing.start_date === input.start_date &&
    existing.start_time.slice(0, 5) === input.start_time &&
    Number(existing.room_id) === Number(input.room_id);
  if (
    (start < now && !unchangedStart) ||
    end < now ||
    end < start ||
    end >= now + days
  )
    fail(`Chỉ được đặt trong ${days} ngày tính từ hôm nay.`);
  if (!["single", "multiple"].includes(input.mode))
    fail("Chọn Single hoặc Multiple day.");
  if (input.mode === "single" && start !== end)
    fail("Single chỉ áp dụng cho một ngày.");
  const from = minutes(input.start_time),
    to = minutes(input.end_time);
  if (to <= from) fail("Giờ kết thúc phải sau giờ bắt đầu.");
  if (input.mode === "multiple" && (from !== 450 || to !== 1050))
    fail("Multiple day phải đặt trọn ngày 07:30–17:30.");
  if (start === now || end === now) {
    const current = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
    if (
      today === todayVN() &&
      start === now &&
      from <= minutes(current) &&
      !unchangedStart
    )
      fail("Giờ bắt đầu phải ở tương lai.");
    if (today === todayVN() && end === now && to <= minutes(current))
      fail("Cuộc họp đã kết thúc, không thể chỉnh sửa.");
  }
  if (room.status !== "active") fail("Phòng đang bảo trì.");
  const count = Number(input.participant_count);
  if (!Number.isInteger(count) || count < 1 || count > room.capacity)
    fail(`Số người phải từ 1 đến ${room.capacity}.`);
  for (const [field, max] of [
    ["title", 255],
    ["incharge", 255],
    ["phone", 40],
  ]) {
    if (
      typeof input[field] !== "string" ||
      !input[field].trim() ||
      input[field].length > max
    )
      fail("Vui lòng nhập đủ tên cuộc họp, người phụ trách và số điện thoại.");
  }
  if (!/^[+\d\s().-]{8,40}$/.test(input.phone))
    fail("Số điện thoại không hợp lệ.");
  if (typeof input.note !== "string" || input.note.length > 4000)
    fail("Ghi chú tối đa 4000 ký tự.");
  const raw = Array.isArray(input.participants)
    ? input.participants
    : String(input.participants || "").split(/[;,\s]+/);
  const participants = [
    ...new Set(
      raw
        .filter(Boolean)
        .map((x) => String(x).trim().toLowerCase())
        .map((x) => (x.includes("@") ? x : x + "@cp.com.vn")),
    ),
  ];
  if (
    participants.length > 200 ||
    participants.some((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
  )
    fail("Email người tham gia không hợp lệ.");
  return { status: auto ? "approved" : "pending", participants, count };
}
module.exports = { validateBooking, todayVN, dayNumber, minutes, fail };
