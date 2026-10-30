const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  validateBooking,
  dayNumber,
  minutes,
} = require("../src/services/bookingRules");
const room = { floor_id: 2, level: 2, capacity: 12, status: "active" };
const base = {
  mode: "single",
  start_date: "2030-01-02",
  end_date: "2030-01-02",
  start_time: "08:00",
  end_time: "09:00",
  participant_count: 5,
  title: "Planning",
  incharge: "Owner",
  phone: "0901234567",
  note: "",
  participants: "alice, bob@cp.com.vn; alice",
};
const validate = (patch = {}, r = room, floor = 2) =>
  validateBooking({ ...base, ...patch }, r, floor, "2030-01-01");
test("ongoing multi-day bookings may extend without changing the original start", () => {
  const input = {...base, room_id:1, mode:'multiple', start_date:'2029-12-31', end_date:'2030-01-02', start_time:'07:30', end_time:'17:30'};
  const previous = {room_id:1, start_date:'2029-12-31', start_time:'07:30:00'};
  assert.equal(validateBooking(input, room, 2, '2030-01-01', previous).status, 'approved');
  assert.throws(() => validateBooking({...input,room_id:2},room,2,'2030-01-01',previous));
});
test("same floor automatically approved; participants normalized and deduplicated", () => {
  const result = validate();
  assert.equal(result.status, "approved");
  assert.deepEqual(result.participants, ["alice@cp.com.vn", "bob@cp.com.vn"]);
});
test("floor 1 automatically approved even without home floor", () =>
  assert.equal(validate({}, { ...room, level: 1 }, null).status, "approved"));
test("different floor requires approval", () =>
  assert.equal(validate({}, room, 3).status, "pending"));
test("unassigned home floor requires approval above floor 1", () =>
  assert.equal(validate({}, room, null).status, "pending"));
test("home floor allows 30 inclusive days, rejects day 31", () => {
  validate({ start_date: "2030-01-30", end_date: "2030-01-30" });
  assert.throws(() =>
    validate({ start_date: "2030-01-31", end_date: "2030-01-31" }),
  );
});
test("different floor allows today through day 3, rejects day 4", () => {
  validate({ start_date: "2030-01-03", end_date: "2030-01-03" }, room, 3);
  assert.throws(() =>
    validate({ start_date: "2030-01-04", end_date: "2030-01-04" }, room, 3),
  );
});
test("multiple day requires all-day hours and validates end of range", () => {
  validate({
    mode: "multiple",
    end_date: "2030-01-04",
    start_time: "07:30",
    end_time: "17:30",
  });
  assert.throws(() => validate({ mode: "multiple", end_date: "2030-01-04" }));
  assert.throws(() =>
    validate({
      mode: "multiple",
      end_date: "2030-02-01",
      start_time: "07:30",
      end_time: "17:30",
    }),
  );
});
test("single mode rejects multi-day ranges", () =>
  assert.throws(() => validate({ end_date: "2030-01-03" })));
test("rejects reversed and past dates", () => {
  assert.throws(() => validate({ end_date: "2030-01-01" }));
  assert.throws(() =>
    validate({ start_date: "2029-12-31", end_date: "2029-12-31" }),
  );
});
test("rejects invalid dates and times", () => {
  assert.throws(() => dayNumber("2030-02-30"));
  assert.throws(() => dayNumber("01/02/2030"));
  assert.throws(() => minutes("25:00"));
  assert.throws(() => validate({ start_time: "10:00", end_time: "09:00" }));
});
test("single bookings may end after 17:30 (PDF page 13)", () => {
  validate({ start_time: "17:30", end_time: "19:00" });
});
test("capacity, maintenance and required contact validation", () => {
  for (const patch of [
    { participant_count: 13 },
    { participant_count: 0 },
    { participant_count: 1.5 },
    { title: "" },
    { incharge: "" },
    { phone: "wrong" },
    { note: "x".repeat(4001) },
  ])
    assert.throws(() => validate(patch));
  assert.throws(() => validate({}, { ...room, status: "maintenance" }));
});
test("rejects malformed participants instead of sending mail", () =>
  assert.throws(() => validate({ participants: "bad@@example.com" })));

// HTTP tests exercise authorization, transitions and conflict handling without sending mail or modifying the configured database.
const express = require("express");
const routes = require("../src/routes/meetings.routes");
async function request(
  db,
  body,
  path = "/api/meeting/bookings",
  method = "POST",
  user = { id: 1, role: "user" },
) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    routes({
      db,
      authMiddleware: (req, res, next) => {
        req.user = user;
        next();
      },
      requireAdmin: (req, res, next) =>
        user.role === "admin" ? next() : res.sendStatus(403),
      handleServerError: (res, e) =>
        res.status(500).json({ message: e.message }),
      logActivity: async () => {},
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
test("administrator can add a room beyond the initial three", async () => {
  const result = await request(
    { withTransaction: async (fn) => fn({ query: async (sql, params) => {
      assert.match(sql, /INSERT INTO meeting_rooms/);
      assert.deepEqual(params, ["Phòng mới", 17, 20, "", "active", false, null]);
      return { rows: [{ id: 20, name: params[0], floor_id: params[1], capacity: params[2] }] };
    } }) },
    { name: "  Phòng mới  ", floor_id: 17, capacity: 20 },
    "/api/meeting/rooms", "POST", { id: 1, role: "admin" },
  );
  assert.equal(result.status, 201);
  assert.equal(result.body.name, "Phòng mới");
});

test("adding a room rejects invalid access group or capacity before inserting", async () => {
  for (const patch of [{ floor_id: 0 }, { capacity: 0 }]) {
    const result = await request(
      { query: async () => { throw new Error("Must not insert invalid room"); } },
      { name: "Phòng mới", floor_id: 17, capacity: 20, ...patch },
      "/api/meeting/rooms", "POST", { id: 1, role: "admin" },
    );
    assert.equal(result.status, 400);
  }
});

test("new room creates its own access group without a floor selector", async () => {
  const queries = [];
  const c = { query: async (sql, params) => {
    queries.push(sql);
    if (sql.includes("pg_advisory")) return { rows: [] };
    if (sql.includes("INSERT INTO meeting_sites")) return { rows: [{ id: 3 }] };
    if (sql.includes("INSERT INTO meeting_floors")) return { rows: [{ id: 24 }] };
    assert.match(sql, /INSERT INTO meeting_rooms/);
    assert.deepEqual(params, ["New room", 24, 12, "", "active", true, null]);
    return { rows: [{ id: 24, name: "New room", is_default: true }] };
  } };
  const result = await request({ withTransaction: fn => fn(c) }, { name: "New room", capacity: 12, is_default: true }, "/api/meeting/rooms", "POST", { id: 1, role: "admin" });
  assert.equal(result.status, 201);
  assert.equal(queries.length, 4);
});

test("default flag controls automatic approval independently of floor level", () => {
  assert.equal(validate({}, { ...room, level: 3, floor_id: 30, is_default: true }).status, "approved");
  assert.equal(validate({}, { ...room, level: 1, floor_id: 30, is_default: false }).status, "pending");
});

test("room deletion preserves history and refuses rooms with future bookings", async () => {
  for (const hasBookings of [true, false]) {
    let archived = false;
    const c = { query: async (sql) => {
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: 20 }] };
      if (sql.includes("SELECT 1 FROM meeting_bookings")) return { rows: hasBookings ? [{}] : [] };
      assert.match(sql, /UPDATE meeting_rooms SET archived_at=NOW/);
      archived = true;
      return { rows: [] };
    } };
    const result = await request({ withTransaction: fn => fn(c) }, {}, "/api/meeting/rooms/20", "DELETE", { id: 1, role: "admin" });
    assert.equal(result.status, hasBookings ? 409 : 200);
    assert.equal(archived, !hasBookings);
  }
});

test("room edit persists the default flag", async () => {
  let updated = false;
  const c = { query: async (sql, params) => {
    if (sql.includes("FOR UPDATE")) return { rows: [{ id: 20, name: "Room" }] };
    if (sql.includes("SELECT 1 FROM meeting_bookings")) return { rows: [] };
    assert.match(sql, /is_default=COALESCE/);
    assert.equal(params[5], true);
    updated = true;
    return { rows: [{ id: 20, is_default: true }] };
  } };
  const result = await request({ withTransaction: fn => fn(c) }, { name: "Room", capacity: 12, equipment: "", status: "active", is_default: true }, "/api/meeting/rooms/20", "PUT", { id: 1, role: "admin" });
  assert.equal(result.status, 200);
  assert.equal(updated, true);
  assert.equal(result.body.is_default, true);
});

test("room photos persist on creation and can be replaced, retained or removed", async () => {
  const photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=";
  const body = { name: "Room", floor_id: 2, capacity: 12, equipment: "", status: "active" };
  const created = await request({ withTransaction: fn => fn({ query: async (sql, params) => {
    assert.equal(params[6], photo);
    return { rows: [{ id: 20, image: params[6] }] };
  } }) }, { ...body, image: photo }, "/api/meeting/rooms", "POST", { id: 1, role: "admin" });
  assert.equal(created.status, 201);
  assert.equal(created.body.image, photo);
  for (const patch of [{ image: photo }, {}, { image: null }]) {
    const existing = patch.image === photo ? null : photo;
    const result = await request({ withTransaction: fn => fn({ query: async (sql, params) => {
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: 20, image: existing }] };
      if (sql.includes("SELECT 1 FROM meeting_bookings")) return { rows: [] };
      return { rows: [{ id: 20, image: params[6] }] };
    } }) }, { ...body, ...patch }, "/api/meeting/rooms/20", "PUT", { id: 1, role: "admin" });
    assert.equal(result.status, 200);
    assert.equal(result.body.image, patch.image === null ? null : photo);
  }
});

test("room photos reject unsafe, malformed and oversized input before database access", async () => {
  for (const image of ["https://example.com/photo.jpg", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,YmFk", "x".repeat(180001)]) {
    for (const method of ["POST", "PUT"]) {
      const result = await request({}, { name: "Room", capacity: 12, image }, method === "POST" ? "/api/meeting/rooms" : "/api/meeting/rooms/20", method, { id: 1, role: "admin" });
      assert.equal(result.status, 400);
    }
  }
});

test("conflicting booking returns 409 and does not insert", async () => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  const tomorrow = date.toISOString().slice(0, 10);
  let inserted = false;
  const c = {
    query: async (sql) => {
      if (sql.includes("FOR UPDATE OF r"))
        return { rows: [{ ...room, id: 1 }] };
      if (sql.includes("SELECT meeting_floor_id"))
        return { rows: [{ meeting_floor_id: 2 }] };
      if (sql.includes("SELECT id FROM meeting_bookings")) {
        assert.match(sql, /INTERVAL '30 minutes'/);
        return { rows: [{ id: 9 }] };
      }
      inserted = true;
      return { rows: [] };
    },
  };
  const result = await request(
    { withTransaction: (fn) => fn(c) },
    { ...base, room_id: 1, start_date: tomorrow, end_date: tomorrow },
  );
  assert.equal(result.status, 409);
  assert.equal(inserted, false);
});
test("user cannot approve or cancel another users booking", async () => {
  const c = {
    query: async (sql) =>
      sql.includes("FOR UPDATE OF b")
        ? { rows: [{ id: 8, created_by: 2, floor_id: 2, status: "pending" }] }
        : { rows: [] },
  };
  for (const action of ["approve", "reject", "cancel"]) {
    const result = await request(
      { withTransaction: (fn) => fn(c) },
      { action, reason: "Reason" },
      "/api/meeting/bookings/8",
      "PATCH",
    );
    assert.equal(result.status, 403);
  }
});
test("cancel and reject require a reason", async () => {
  for (const action of ["cancel", "reject"])
    assert.equal(
      (
        await request(
          {},
          { action, reason: " " },
          "/api/meeting/bookings/8",
          "PATCH",
        )
      ).status,
      400,
    );
});
test("terminal bookings cannot be approved again", async () => {
  const c = { query: async () => ({ rows: [{ id: 8, status: "cancelled" }] }) };
  const result = await request(
    { withTransaction: (fn) => fn(c) },
    { action: "approve" },
    "/api/meeting/bookings/8",
    "PATCH",
    { id: 1, role: "admin" },
  );
  assert.equal(result.status, 409);
});
