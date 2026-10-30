const express = require("express");
const validImage = require("../avatar");
const {
  validateBooking,
  todayVN,
  dayNumber,
  fail,
} = require("../services/bookingRules");

module.exports = ({
  db,
  authMiddleware,
  requireAdmin,
  handleServerError,
  logActivity,
}) => {
  const r = express.Router();
  r.use("/api/meeting", authMiddleware);
  const route = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ message: e.message });
      if (e.code === "23505")
        return res.status(409).json({ message: "Thông tin đã tồn tại." });
      if (["23503", "22P02"].includes(e.code))
        return res
          .status(400)
          .json({ message: "Phòng, tầng hoặc tài khoản không hợp lệ." });
      return handleServerError(res, e, "meeting");
    }
  };
  const manager = async (c, user, floor) =>
    user.role === "admin" ||
    (
      await c.query(
        "SELECT 1 FROM meeting_floor_admins WHERE user_id=$1 AND floor_id=$2",
        [user.id, floor],
      )
    ).rows.length > 0;
  async function notify(c, b, status) {
    const { rows } = await c.query(
      "SELECT id,email FROM users WHERE id=$1 OR id IN (SELECT user_id FROM meeting_floor_admins WHERE floor_id=(SELECT floor_id FROM meeting_rooms WHERE id=$2))",
      [b.created_by, b.room_id],
    );
    const labels = {
      pending: "chờ quản trị tầng duyệt",
      approved: "đã được phê duyệt",
      rejected: "đã bị từ chối",
      cancelled: "đã bị hủy",
    };
    const message = `#${b.id} · ${b.title}: ${labels[status]}${b.reason ? ". Lý do: " + b.reason : ""}`;
    for (const u of rows)
      await c.query(
        "INSERT INTO meeting_notifications(user_id,booking_id,message) VALUES ($1,$2,$3)",
        [u.id, b.id, message],
      );
    const recipients = [
      ...new Set([
        ...rows.map((u) => u.email),
        ...(status === "pending" ? [] : b.participants),
      ]),
    ].filter(Boolean);
    if (recipients.length)
      await c.query(
        "INSERT INTO meeting_email_outbox(booking_id,recipients,subject,body) VALUES ($1,$2,$3,$4)",
        [
          b.id,
          recipients,
          "Meeting Room Booking · " + labels[status],
          `${message}\n${String(b.start_date).slice(0, 10)} – ${String(b.end_date).slice(0, 10)}\n${b.start_time} – ${b.end_time}\nPhụ trách: ${b.incharge}\nĐiện thoại: ${b.phone}\nGhi chú: ${b.note}`,
        ],
      );
  }
  r.get(
    "/api/meeting/catalog",
    route(async (req, res) => {
      const results = await Promise.all([
        db.query("SELECT * FROM meeting_sites s WHERE EXISTS (SELECT 1 FROM meeting_floors f JOIN meeting_rooms r ON r.floor_id=f.id WHERE f.site_id=s.id AND r.archived_at IS NULL) ORDER BY name"),
        db.query("SELECT * FROM meeting_floors f WHERE EXISTS (SELECT 1 FROM meeting_rooms r WHERE r.floor_id=f.id AND r.archived_at IS NULL) ORDER BY site_id,level"),
        db.query(
          "SELECT r.*,f.site_id,f.level,f.name AS floor_name,s.name AS site_name FROM meeting_rooms r JOIN meeting_floors f ON f.id=r.floor_id JOIN meeting_sites s ON s.id=f.site_id WHERE r.archived_at IS NULL ORDER BY s.name,f.level,r.name",
        ),
        db.query("SELECT meeting_floor_id FROM users WHERE id=$1", [
          req.user.id,
        ]),
        db.query("SELECT floor_id FROM meeting_floor_admins WHERE user_id=$1", [
          req.user.id,
        ]),
      ]);
      res.json({
        sites: results[0].rows,
        floors: results[1].rows,
        rooms: results[2].rows,
        home_floor_id: results[3].rows[0]?.meeting_floor_id,
        admin_floor_ids: results[4].rows.map((x) => x.floor_id),
        today: todayVN(),
      });
    }),
  );
  r.get(
    "/api/meeting/bookings",
    route(async (req, res) => {
      const from = req.query.from || todayVN(),
        to = req.query.to || from;
      if (
        dayNumber(to) < dayNumber(from) ||
        dayNumber(to) - dayNumber(from) > 366
      )
        fail("Khoảng tra cứu tối đa 366 ngày.");
      const { rows } = await db.query(
        `SELECT b.*,b.start_date::text,b.end_date::text,r.name AS room_name,r.floor_id,f.name AS floor_name,s.name AS site_name,u.name AS creator_name
   FROM meeting_bookings b JOIN meeting_rooms r ON r.id=b.room_id JOIN meeting_floors f ON f.id=r.floor_id
   JOIN meeting_sites s ON s.id=f.site_id JOIN users u ON u.id=b.created_by
   WHERE b.start_date <= $2 AND b.end_date >= $1 ORDER BY b.start_date,b.start_time,b.id`,
        [from, to],
      );
      // Calendar exposes title and time; contact details remain private to owner/floor admins.
      const floors = (
        await db.query(
          "SELECT floor_id FROM meeting_floor_admins WHERE user_id=$1",
          [req.user.id],
        )
      ).rows.map((x) => x.floor_id);
      res.json(
        rows.map((b) => {
          const canManage =
            req.user.role === "admin" || floors.includes(b.floor_id);
          const own = b.created_by === req.user.id;
          return {
            ...b,
            participants: own || canManage ? b.participants : [],
            phone: own || canManage ? b.phone : "",
            note: own || canManage ? b.note : "",
            incharge: own || canManage ? b.incharge : "",
            can_manage: canManage,
            can_cancel:
              (own || canManage) && ["approved", "pending"].includes(b.status),
          };
        }),
      );
    }),
  );
  const saveBooking = route(async (req, res) => {
    const b = req.body;
    const result = await db.withTransaction(async (c) => {
      // Serialize requests per room, including simultaneous bookings on different server processes.
      const { rows } = await c.query(
        "SELECT r.*,f.level FROM meeting_rooms r JOIN meeting_floors f ON f.id=r.floor_id WHERE r.id=$1 FOR UPDATE OF r",
        [b.room_id],
      );
      if (!rows.length) fail("Không tìm thấy phòng.", 404);
      if (rows[0].archived_at) fail("Phòng đã được xóa khỏi danh mục.", 409);
      let previous;
      if (req.params.id) {
        previous = (
          await c.query(
            "SELECT *,start_date::text,end_date::text FROM meeting_bookings WHERE id=$1 FOR UPDATE",
            [req.params.id],
          )
        ).rows[0];
        if (!previous) fail("Không tìm thấy lịch đặt.", 404);
        const oldRoom = (
          await c.query("SELECT floor_id FROM meeting_rooms WHERE id=$1", [
            previous.room_id,
          ])
        ).rows[0];
        if (
          previous.created_by !== req.user.id &&
          !(await manager(c, req.user, oldRoom.floor_id))
        )
          fail("Bạn không có quyền chỉnh sửa.", 403);
        if (!["approved", "pending"].includes(previous.status))
          fail("Lịch đã hủy hoặc từ chối không thể chỉnh sửa.", 409);
      }
      const ownerId = previous?.created_by || req.user.id;
      const profile = (
        await c.query("SELECT meeting_floor_id FROM users WHERE id=$1", [
          ownerId,
        ])
      ).rows[0];
      const v = validateBooking(
        b,
        rows[0],
        profile.meeting_floor_id,
        todayVN(),
        previous,
      );
      const conflict = await c.query(
        `SELECT id FROM meeting_bookings b WHERE room_id=$1 AND status IN ('pending','approved') AND ($6::integer IS NULL OR id<>$6)
    AND start_date <= $3::date + 1 AND end_date >= $2::date - 1
    AND EXISTS (SELECT 1 FROM generate_series(b.start_date::timestamp,b.end_date::timestamp,INTERVAL '1 day') old_day(day)
     CROSS JOIN generate_series($2::timestamp,$3::timestamp,INTERVAL '1 day') new_day(day)
     WHERE old_day.day::date + b.start_time < new_day.day::date + $5::time + INTERVAL '30 minutes'
     AND old_day.day::date + b.end_time + INTERVAL '30 minutes' > new_day.day::date + $4::time) LIMIT 1`,
        [
          b.room_id,
          b.start_date,
          b.end_date,
          b.start_time,
          b.end_time,
          previous?.id || null,
        ],
      );
      if (conflict.rows.length)
        fail(
          "Phòng đã có lịch hoặc chưa đủ 30 phút dọn dẹp giữa hai cuộc họp.",
          409,
        );
      const params = [
        b.room_id,
        ownerId,
        b.title.trim(),
        b.mode,
        b.start_date,
        b.end_date,
        b.start_time,
        b.end_time,
        v.participants,
        v.count,
        b.incharge.trim(),
        b.phone.trim(),
        b.note,
        v.status,
      ];
      const inserted = previous
        ? await c.query(
            `UPDATE meeting_bookings SET room_id=$1,created_by=$2,title=$3,mode=$4,start_date=$5,end_date=$6,start_time=$7,end_time=$8,participants=$9,participant_count=$10,incharge=$11,phone=$12,note=$13,status=$14,reason=NULL,reviewed_by=NULL,updated_at=NOW() WHERE id=$15 RETURNING *,start_date::text,end_date::text`,
            [...params, previous.id],
          )
        : await c.query(
            `INSERT INTO meeting_bookings(room_id,created_by,title,mode,start_date,end_date,start_time,end_time,participants,participant_count,incharge,phone,note,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *,start_date::text,end_date::text`,
            params,
          );
      await notify(c, inserted.rows[0], v.status);
      return inserted.rows[0];
    });
    await logActivity(
      req,
      req.params.id ? "UPDATE_MEETING_ROOM" : "BOOK_MEETING_ROOM",
      result.id,
      null,
      { status: result.status },
    );
    res.status(req.params.id ? 200 : 201).json(result);
  });
  r.post("/api/meeting/bookings", saveBooking);
  r.put("/api/meeting/bookings/:id", saveBooking);
  r.patch(
    "/api/meeting/bookings/:id",
    route(async (req, res) => {
      const { action, reason } = req.body;
      if (!["approve", "reject", "cancel"].includes(action))
        fail("Thao tác không hợp lệ.");
      if (
        action !== "approve" &&
        (typeof reason !== "string" || !reason.trim() || reason.length > 2000)
      )
        fail("Vui lòng nhập lý do (tối đa 2000 ký tự).");
      const result = await db.withTransaction(async (c) => {
        const { rows } = await c.query(
          "SELECT b.*,r.floor_id FROM meeting_bookings b JOIN meeting_rooms r ON r.id=b.room_id WHERE b.id=$1 FOR UPDATE OF b",
          [req.params.id],
        );
        if (!rows.length) fail("Không tìm thấy lịch đặt.", 404);
        const b = rows[0];
        const canManage = await manager(c, req.user, b.floor_id);
        if (
          action === "cancel"
            ? b.created_by !== req.user.id && !canManage
            : !canManage
        )
          fail("Bạn không có quyền thực hiện.", 403);
        if (
          action === "cancel"
            ? !["pending", "approved"].includes(b.status)
            : b.status !== "pending"
        )
          fail("Trạng thái lịch đặt đã thay đổi.", 409);
        const status = {
          approve: "approved",
          reject: "rejected",
          cancel: "cancelled",
        }[action];
        const updated = await c.query(
          "UPDATE meeting_bookings SET status=$2,reason=$3,reviewed_by=$4,updated_at=NOW() WHERE id=$1 RETURNING *,start_date::text,end_date::text",
          [
            b.id,
            status,
            action === "approve" ? null : reason.trim(),
            req.user.id,
          ],
        );
        await notify(c, updated.rows[0], status);
        return updated.rows[0];
      });
      await logActivity(req, "MEETING_" + action.toUpperCase(), result.id);
      res.json(result);
    }),
  );
  r.get(
    "/api/meeting/notifications",
    route(async (req, res) =>
      res.json(
        (
          await db.query(
            "SELECT * FROM meeting_notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 100",
            [req.user.id],
          )
        ).rows,
      ),
    ),
  );
  r.patch(
    "/api/meeting/notifications/read",
    route(async (req, res) => {
      await db.query(
        "UPDATE meeting_notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL",
        [req.user.id],
      );
      res.json({ ok: true });
    }),
  );
  r.post(
    "/api/meeting/rooms",
    requireAdmin,
    route(async (req, res) => {
      const { name, floor_id, capacity, equipment = "", status = "active", is_default = false, image = null } = req.body;
      if (!validImage(image)) fail("Ảnh phòng không hợp lệ. Chỉ hỗ trợ JPEG, PNG hoặc WebP tối đa 180 KB.");
      if (
        typeof name !== "string" || !name.trim() || name.length > 120 ||
        (floor_id !== undefined && (!Number.isInteger(Number(floor_id)) || Number(floor_id) < 1)) ||
        typeof is_default !== "boolean" ||
        !Number.isInteger(Number(capacity)) || Number(capacity) < 1 || Number(capacity) > 1000 ||
        !["active", "maintenance"].includes(status) ||
        typeof equipment !== "string" || equipment.length > 2000
      ) fail("Thông tin phòng không hợp lệ.");
      const room = await db.withTransaction(async (c) => {
        let groupId = floor_id;
        if (groupId === undefined) {
          await c.query("SELECT pg_advisory_xact_lock(82461103)");
          const site = (await c.query(
            "INSERT INTO meeting_sites(name) VALUES ('Phòng họp') ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id",
          )).rows[0];
          const group = (await c.query(
            "INSERT INTO meeting_floors(site_id,name,level) SELECT $1,$2,COALESCE(MAX(level),0)+1 FROM meeting_floors WHERE site_id=$1 RETURNING id",
            [site.id, name.trim()],
          )).rows[0];
          groupId = group.id;
        }
        return (await c.query(
          "INSERT INTO meeting_rooms(name,floor_id,capacity,equipment,status,is_default,image) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [name.trim(), Number(groupId), Number(capacity), equipment, status, is_default, image || null],
        )).rows[0];
      });
      res.status(201).json(room);
    }),
  );
  r.put(
    "/api/meeting/rooms/:id",
    requireAdmin,
    route(async (req, res) => {
      const { name, capacity, equipment, status, is_default, image } = req.body;
      if (!validImage(image)) fail("Ảnh phòng không hợp lệ. Chỉ hỗ trợ JPEG, PNG hoặc WebP tối đa 180 KB.");
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 120 ||
        (is_default !== undefined && typeof is_default !== "boolean") ||
        !Number.isInteger(Number(capacity)) ||
        Number(capacity) < 1 ||
        Number(capacity) > 1000 ||
        !["active", "maintenance"].includes(status) ||
        typeof equipment !== "string" ||
        equipment.length > 2000
      )
        fail("Thông tin phòng không hợp lệ.");
      const room = await db.withTransaction(async (c) => {
        const existing = await c.query(
          "SELECT * FROM meeting_rooms WHERE id=$1 FOR UPDATE",
          [req.params.id],
        );
        if (!existing.rows.length) fail("Không tìm thấy phòng.", 404);
        if (existing.rows[0].archived_at) fail("Phòng đã được xóa khỏi danh mục.", 404);
        if (status === "maintenance") {
          const future = await c.query(
            "SELECT 1 FROM meeting_bookings WHERE room_id=$1 AND status IN ('pending','approved') AND end_date >= $2 LIMIT 1",
            [req.params.id, todayVN()],
          );
          if (future.rows.length)
            fail(
              "Hãy hủy hoặc xử lý các lịch đặt sắp tới trước khi bảo trì.",
              409,
            );
        }
        const oversized = await c.query(
          "SELECT 1 FROM meeting_bookings WHERE room_id=$1 AND status IN ('pending','approved') AND end_date >= $2 AND participant_count > $3 LIMIT 1",
          [req.params.id, todayVN(), capacity],
        );
        if (oversized.rows.length)
          fail("Sức chứa mới nhỏ hơn số người của lịch đặt sắp tới.", 409);
        return (
          await c.query(
            "UPDATE meeting_rooms SET name=$2,capacity=$3,equipment=$4,status=$5,is_default=COALESCE($6,is_default),image=$7 WHERE id=$1 RETURNING *",
            [req.params.id, name.trim(), capacity, equipment, status, is_default ?? null, image === undefined ? existing.rows[0].image ?? null : image || null],
          )
        ).rows[0];
      });
      res.json(room);
    }),
  );
  r.delete(
    "/api/meeting/rooms/:id",
    requireAdmin,
    route(async (req, res) => {
      await db.withTransaction(async (c) => {
        const room = (await c.query("SELECT * FROM meeting_rooms WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
        if (!room || room.archived_at) fail("Không tìm thấy phòng.", 404);
        const upcoming = await c.query(
          "SELECT 1 FROM meeting_bookings WHERE room_id=$1 AND status IN ('pending','approved') AND end_date >= $2 LIMIT 1",
          [req.params.id, todayVN()],
        );
        if (upcoming.rows.length) fail("Hãy hủy hoặc xử lý các lịch đặt sắp tới trước khi xóa phòng.", 409);
        await c.query("UPDATE meeting_rooms SET archived_at=NOW() WHERE id=$1", [req.params.id]);
      });
      res.json({ ok: true });
    }),
  );
  r.get(
    "/api/meeting/access",
    requireAdmin,
    route(async (req, res) => {
      const [users, assignments, mail] = await Promise.all([
        db.query(
          "SELECT id,name,email,role,meeting_floor_id FROM users WHERE role IN ('admin', 'manager') ORDER BY name",
        ),
        db.query("SELECT * FROM meeting_floor_admins"),
        db.query(
          "SELECT COUNT(*) FILTER(WHERE sent_at IS NULL)::int AS pending,COUNT(*) FILTER(WHERE attempts>=5 AND sent_at IS NULL)::int AS failed FROM meeting_email_outbox",
        ),
      ]);
      res.json({
        users: users.rows,
        assignments: assignments.rows,
        email: {
          configured: !!(process.env.SMTP_HOST && process.env.SMTP_FROM),
          ...mail.rows[0],
        },
      });
    }),
  );
  r.put(
    "/api/meeting/access/:id",
    requireAdmin,
    route(async (req, res) => {
      const { meeting_floor_id, admin_floor_ids } = req.body;
      if (
        !Array.isArray(admin_floor_ids) ||
        admin_floor_ids.some((x) => !Number.isInteger(x))
      )
        fail("Danh sách tầng không hợp lệ.");
      await db.withTransaction(async (c) => {
        const user = await c.query(
          "SELECT id FROM users WHERE id=$1 FOR UPDATE",
          [req.params.id],
        );
        if (!user.rows.length) fail("Không tìm thấy tài khoản.", 404);
        await c.query("UPDATE users SET meeting_floor_id=$2 WHERE id=$1", [
          req.params.id,
          meeting_floor_id || null,
        ]);
        await c.query("DELETE FROM meeting_floor_admins WHERE user_id=$1", [
          req.params.id,
        ]);
        for (const floor of new Set(admin_floor_ids))
          await c.query(
            "INSERT INTO meeting_floor_admins(user_id,floor_id) VALUES ($1,$2)",
            [req.params.id, floor],
          );
      });
      res.json({ ok: true });
    }),
  );
  return r;
};
