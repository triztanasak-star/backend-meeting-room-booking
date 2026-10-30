// Opt-in test against an isolated, migrated PostgreSQL instance, never the .env database.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const url = process.env.MEETING_TEST_DATABASE_URL;
if (
  !url ||
  !["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
  new URL(url).port !== "55439"
) {
  throw new Error(
    "Set MEETING_TEST_DATABASE_URL to an isolated local PostgreSQL instance on port 55439.",
  );
}
process.env.DATABASE_URL = url;
process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "meeting-tests-access-secret-32-characters";
process.env.JWT_REFRESH_SECRET = "meeting-tests-refresh-secret-32-characters";
const db = require("../src/db");
const bcrypt = require("bcrypt");
const app = require("../src/app");
const { todayVN } = require("../src/services/bookingRules");
let server,
  base,
  owner,
  reviewer,
  other,
  admin,
  rooms,
  catalog,
  first,
  second,
  pending;
const date = new Date(todayVN() + "T12:00:00Z");
date.setUTCDate(date.getUTCDate() + 1);
const tomorrow = date.toISOString().slice(0, 10);
date.setUTCDate(date.getUTCDate() + 1);
const next = date.toISOString().slice(0, 10);
async function call(path, method = "GET", data, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: res.status, data: await res.json() };
}
const payload = (room, patch = {}) => ({
  room_id: room.id,
  mode: "single",
  start_date: tomorrow,
  end_date: tomorrow,
  start_time: "08:00",
  end_time: "09:00",
  title: "Integration meeting",
  participants: "alice",
  participant_count: 4,
  incharge: "Organizer",
  phone: "0901234567",
  note: "Microphone",
  ...patch,
});
before(async () => {
  const password = await bcrypt.hash("BookingTest123", 4);
  const suffix = Date.now();
  for (const [label, role] of [
    ["admin", "admin"],
    ["owner", "user"],
    ["reviewer", "user"],
    ["other", "user"],
  ]) {
    const { rows } = await db.query(
      "INSERT INTO users(name,email,role,status,password_hash) VALUES($1,$2,$3,'active',$4) RETURNING id,email",
      [label, `${label}-${suffix}@example.test`, role, password],
    );
    if (label === "admin") admin = rows[0];
    if (label === "owner") owner = rows[0];
    if (label === "reviewer") reviewer = rows[0];
    if (label === "other") other = rows[0];
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of [admin, owner, reviewer, other]) {
    const login = await call("/api/auth/login", "POST", {
      email: u.email,
      password: "BookingTest123",
    });
    assert.equal(login.status, 200);
    u.token = login.data.token;
  }
  catalog = (await call("/api/meeting/catalog", "GET", null, admin.token)).data;
  rooms = [1, 2, 3].map((level) =>
    catalog.rooms.find((r) => r.site_name === "Phòng họp" && r.level === level),
  );
  for (let i = 0; i < rooms.length; i++) {
    const created = (
      await db.query(
        "INSERT INTO meeting_rooms(floor_id,name,capacity,equipment) VALUES($1,$2,12,$3) RETURNING *",
        [rooms[i].floor_id, `Test-${suffix}-${i}`, "Screen"],
      )
    ).rows[0];
    rooms[i] = { ...rooms[i], ...created };
  }
  assert.equal(
    (
      await call(
        "/api/meeting/access/" + owner.id,
        "PUT",
        { meeting_floor_id: rooms[1].floor_id, admin_floor_ids: [] },
        admin.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/api/meeting/access/" + reviewer.id,
        "PUT",
        { meeting_floor_id: null, admin_floor_ids: [rooms[2].floor_id] },
        admin.token,
      )
    ).status,
    200,
  );
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.end();
});
test("catalog and room administration require correct permissions", async () => {
  assert.ok(catalog.sites.some((s) => s.name === "Phòng họp"));
  for (const name of ["Phòng họp 1", "Phòng họp 2", "Phòng họp nhà máy"]) {
    assert.ok(catalog.rooms.some((r) => r.name === name));
  }
  assert.equal(
    (
      await call(
        "/api/meeting/rooms",
        "POST",
        { name: "Forbidden" },
        owner.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/api/meeting/access", "GET", null, owner.token)).status,
    403,
  );
});
test("create approved single booking and persist normalized participant", async () => {
  const result = await call(
    "/api/meeting/bookings",
    "POST",
    payload(rooms[0]),
    owner.token,
  );
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.status, "approved");
  assert.deepEqual(result.data.participants, ["alice@cp.com.vn"]);
  first = result.data;
});
test("enforces exact 30-minute gap and rejects overlap", async () => {
  assert.equal(
    (
      await call(
        "/api/meeting/bookings",
        "POST",
        payload(rooms[0], { start_time: "09:29", end_time: "10:00" }),
        owner.token,
      )
    ).status,
    409,
  );
  const result = await call(
    "/api/meeting/bookings",
    "POST",
    payload(rooms[0], { start_time: "09:30", end_time: "10:30" }),
    owner.token,
  );
  assert.equal(result.status, 201, JSON.stringify(result.data));
  second = result.data;
});
test("simultaneous requests cannot double-book a room", async () => {
  const results = await Promise.all([
    call("/api/meeting/bookings", "POST", payload(rooms[1]), owner.token),
    call("/api/meeting/bookings", "POST", payload(rooms[1]), owner.token),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 409]);
});
test("multiple-day holds each day and requires floor administrator approval", async () => {
  const result = await call(
    "/api/meeting/bookings",
    "POST",
    payload(rooms[2], {
      mode: "multiple",
      end_date: next,
      start_time: "07:30",
      end_time: "17:30",
    }),
    owner.token,
  );
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.status, "pending");
  pending = result.data;
  assert.equal(
    (
      await call(
        "/api/meeting/bookings",
        "POST",
        payload(rooms[2], { start_date: next, end_date: next }),
        other.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/api/meeting/bookings/" + pending.id,
        "PATCH",
        { action: "approve" },
        other.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/meeting/bookings/" + pending.id,
        "PATCH",
        { action: "approve" },
        reviewer.token,
      )
    ).status,
    200,
  );
});
test("updates recheck conflicts and enforce ownership", async () => {
  assert.equal(
    (
      await call(
        "/api/meeting/bookings/" + first.id,
        "PUT",
        payload(rooms[0], { end_time: "09:15" }),
        owner.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/api/meeting/bookings/" + first.id,
        "PUT",
        payload(rooms[0], { end_time: "08:45" }),
        other.token,
      )
    ).status,
    403,
  );
  const result = await call(
    "/api/meeting/bookings/" + first.id,
    "PUT",
    payload(rooms[0], { end_time: "08:45", title: "Updated meeting" }),
    owner.token,
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.title, "Updated meeting");
});
test("maintenance blocked with upcoming bookings", async () => {
  const r = rooms[0];
  const result = await call(
    "/api/meeting/rooms/" + r.id,
    "PUT",
    {
      name: r.name,
      capacity: r.capacity,
      equipment: r.equipment,
      status: "maintenance",
    },
    admin.token,
  );
  assert.equal(result.status, 409);
});
test("calendar hides contact details from unrelated users", async () => {
  const result = await call(
    `/api/meeting/bookings?from=${tomorrow}&to=${next}`,
    "GET",
    null,
    other.token,
  );
  assert.equal(result.status, 200);
  const b = result.data.find((b) => b.id === first.id);
  assert.equal(b.phone, "");
  assert.equal(b.note, "");
  assert.deepEqual(b.participants, []);
});
test("cancellation needs reason, releases room, and creates notification and queued email", async () => {
  assert.equal(
    (
      await call(
        "/api/meeting/bookings/" + pending.id,
        "PATCH",
        { action: "cancel", reason: "" },
        owner.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/api/meeting/bookings/" + pending.id,
        "PATCH",
        { action: "cancel", reason: "Schedule changed" },
        owner.token,
      )
    ).status,
    200,
  );
  const replacement = await call(
    "/api/meeting/bookings",
    "POST",
    payload(rooms[2]),
    other.token,
  );
  assert.equal(replacement.status, 201, JSON.stringify(replacement.data));
  const n = await call("/api/meeting/notifications", "GET", null, owner.token);
  assert.ok(n.data.some((n) => n.booking_id === pending.id));
  const mail = await db.query(
    "SELECT * FROM meeting_email_outbox WHERE booking_id=$1",
    [pending.id],
  );
  assert.ok(mail.rows.length >= 3);
  assert.ok(mail.rows.every((m) => m.sent_at === null));
  assert.equal(
    (await call("/api/meeting/notifications/read", "PATCH", {}, owner.token))
      .status,
    200,
  );
});
test("30-minute gap applies across midnight", async () => {
  const newRoom = (
    await db.query(
      "INSERT INTO meeting_rooms(floor_id,name,capacity) VALUES ($1,$2,12) RETURNING *",
      [rooms[0].floor_id, "Midnight-" + Date.now()],
    )
  ).rows[0];
  assert.equal(
    (
      await call(
        "/api/meeting/bookings",
        "POST",
        payload(newRoom, { start_time: "23:00", end_time: "23:50" }),
        owner.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await call(
        "/api/meeting/bookings",
        "POST",
        payload(newRoom, {
          start_date: next,
          end_date: next,
          start_time: "00:19",
          end_time: "01:00",
        }),
        owner.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/api/meeting/bookings",
        "POST",
        payload(newRoom, {
          start_date: next,
          end_date: next,
          start_time: "00:20",
          end_time: "01:00",
        }),
        owner.token,
      )
    ).status,
    201,
  );
});
