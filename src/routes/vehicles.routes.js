const express = require('express');
const { fail, dayNumber, todayVN } = require('../services/bookingRules');
const { validateRequest, validateAssignments } = require('../services/vehicleRules');
module.exports = ({ db, authMiddleware, requireAdmin, handleServerError, logActivity }) => {
  const r = express.Router();
  r.use('/api/vehicles', authMiddleware);
  const route = fn => async (req,res) => {
    try { await fn(req,res); } catch(e) {
      if(e.status) return res.status(e.status).json({message:e.message});
      if(e.code === '42P01') return res.status(503).json({message:'Database đặt xe chưa được khởi tạo. Quản trị viên cần chạy npm run migrate:vehicles trong thư mục backend.'});
      if(['23505','23503','22P02'].includes(e.code)) return res.status(400).json({message:'Dữ liệu trùng hoặc không hợp lệ.'});
      return handleServerError(res,e,'vehicles');
    }
  };
  // All capacity and assignment mutations share this transaction lock across server processes.
  const lock = c => c.query('SELECT pg_advisory_xact_lock(82461104)');
  const manager = async (c,u) => u.role === 'admin' || (await c.query('SELECT 1 FROM vehicle_approvers WHERE user_id=$1',[u.id])).rows.length > 0;
  async function availability(c,date) {
    const {rows} = await c.query(`SELECT (SELECT COUNT(*)::int FROM vehicle_fleet WHERE active) AS total,
      COALESCE((SELECT SUM(quantity)::int FROM vehicle_bookings WHERE booking_date=$1 AND status IN ('pending','approved')),0) AS reserved`,[date]);
    return {...rows[0], remaining: Math.max(0,rows[0].total-rows[0].reserved)};
  }
  r.get('/api/vehicles/calendar',route(async(req,res)=>{
    const from=req.query.from || todayVN(), to=req.query.to || from;
    if(dayNumber(to)<dayNumber(from) || dayNumber(to)-dayNumber(from)>41) fail('Khoảng xem lịch tối đa 42 ngày.');
    const canManage=await manager(db,req.user);
    const {rows}=await db.query(`WITH capacity AS (SELECT COUNT(*)::int AS total FROM vehicle_fleet WHERE active)
      SELECT day::date::text AS date, capacity.total,
      COALESCE(SUM(b.quantity) FILTER(WHERE b.status IN ('pending','approved')),0)::int AS reserved,
      COALESCE(json_agg(json_build_object('id',b.id,'quantity',b.quantity,'destination',b.destination,'status',b.status))
        FILTER(WHERE b.id IS NOT NULL AND b.status IN ('pending','approved') AND ($3::boolean OR b.created_by=$4)), '[]'::json) AS bookings
      FROM generate_series($1::date::timestamp,$2::date::timestamp,INTERVAL '1 day') day
      CROSS JOIN capacity LEFT JOIN vehicle_bookings b ON b.booking_date=day::date
      GROUP BY day,capacity.total ORDER BY day`,[from,to,canManage,req.user.id]);
    res.json({today:todayVN(),days:rows.map(d=>({...d,remaining:Math.max(0,d.total-d.reserved)}))});
  }));
  r.get('/api/vehicles/day',route(async(req,res)=>{
    const date = req.query.date || todayVN(); dayNumber(date);
    const canManage = await manager(db,req.user);
    const bookings = (await db.query(`SELECT b.*,b.booking_date::text,u.name AS creator_name,
      COALESCE((SELECT json_agg(json_build_object('vehicle_id',a.vehicle_id,'driver_id',a.driver_id,'plate',v.plate,'vehicle_name',v.name,'driver_name',d.name,'driver_phone',d.phone)) FROM vehicle_assignments a JOIN vehicle_fleet v ON v.id=a.vehicle_id JOIN vehicle_drivers d ON d.id=a.driver_id WHERE a.booking_id=b.id),'[]'::json) AS assignments
      FROM vehicle_bookings b JOIN users u ON u.id=b.created_by WHERE b.booking_date=$1 AND ($2::boolean OR b.created_by=$3) ORDER BY b.id DESC`,[date,canManage,req.user.id])).rows;
    const fleet = canManage ? (await db.query(`SELECT v.*, EXISTS(SELECT 1 FROM vehicle_assignments a JOIN vehicle_bookings b ON b.id=a.booking_id WHERE a.vehicle_id=v.id AND b.booking_date=$1 AND b.status='approved') AS busy FROM vehicle_fleet v ORDER BY v.id`,[date])).rows : [];
    const drivers = canManage ? (await db.query(`SELECT d.*, EXISTS(SELECT 1 FROM vehicle_assignments a JOIN vehicle_bookings b ON b.id=a.booking_id WHERE a.driver_id=d.id AND b.booking_date=$1 AND b.status='approved') AS busy FROM vehicle_drivers d ORDER BY d.id`,[date])).rows : [];
    res.json({today:todayVN(),can_manage:canManage,...await availability(db,date),bookings,fleet,drivers});
  }));
  r.post('/api/vehicles/bookings',route(async(req,res)=>{
    validateRequest(req.body);
    const b=req.body;
    const result=await db.withTransaction(async c=>{
      await lock(c);
      if(b.quantity > (await availability(c,b.booking_date)).remaining) fail('Không còn đủ xe trong ngày đã chọn.',409);
      return (await c.query(`INSERT INTO vehicle_bookings(created_by,booking_date,quantity,destination,purpose,phone) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.user.id,b.booking_date,b.quantity,b.destination.trim(),b.purpose.trim(),b.phone.trim()])).rows[0];
    });
    await logActivity(req,'BOOK_VEHICLE',result.id); res.status(201).json(result);
  }));
  r.patch('/api/vehicles/bookings/:id',route(async(req,res)=>{
    const {action,reason,assignments}=req.body;
    if(!['approve','reject','cancel'].includes(action)) fail('Thao tác không hợp lệ.');
    if(action!=='approve' && (typeof reason!=='string' || !reason.trim() || reason.length>2000)) fail('Vui lòng nhập lý do, tối đa 2000 ký tự.');
    const result=await db.withTransaction(async c=>{
      await lock(c);
      const b=(await c.query('SELECT *,booking_date::text FROM vehicle_bookings WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if(!b) fail('Không tìm thấy yêu cầu.',404);
      const manage=await manager(c,req.user);
      if(action==='cancel' ? !manage && b.created_by!==req.user.id : !manage) fail('Bạn không có quyền xử lý.',403);
      if(action==='cancel' ? !['pending','approved'].includes(b.status) : b.status!=='pending') fail('Yêu cầu đã được xử lý.',409);
      if(b.booking_date<todayVN()) fail('Không thể xử lý lịch đã qua.',409);
      if(action==='approve') {
        validateAssignments(assignments,b.quantity);
        for(const a of assignments) {
          if(!(await c.query('SELECT 1 FROM vehicle_fleet WHERE id=$1 AND active',[a.vehicle_id])).rows.length || !(await c.query('SELECT 1 FROM vehicle_drivers WHERE id=$1 AND active',[a.driver_id])).rows.length) fail('Xe hoặc tài xế không hoạt động.');
          if((await c.query(`SELECT 1 FROM vehicle_assignments a JOIN vehicle_bookings b ON b.id=a.booking_id WHERE b.booking_date=$1 AND b.status='approved' AND (a.vehicle_id=$2 OR a.driver_id=$3)`,[b.booking_date,a.vehicle_id,a.driver_id])).rows.length) fail('Xe hoặc tài xế đã có lịch trong ngày.',409);
          await c.query('INSERT INTO vehicle_assignments(booking_id,vehicle_id,driver_id) VALUES($1,$2,$3)',[b.id,a.vehicle_id,a.driver_id]);
        }
      }
      return (await c.query('UPDATE vehicle_bookings SET status=$2,reason=$3,reviewed_by=$4,updated_at=NOW() WHERE id=$1 RETURNING *',[b.id,{approve:'approved',reject:'rejected',cancel:'cancelled'}[action],action==='approve'?null:reason.trim(),req.user.id])).rows[0];
    });
    await logActivity(req,'VEHICLE_'+action.toUpperCase(),result.id); res.json(result);
  }));
  for(const kind of ['fleet','drivers']) {
    const table=kind==='fleet'?'vehicle_fleet':'vehicle_drivers';
    const field=kind==='fleet'?'plate':'phone';
    const save=route(async(req,res)=>{
      const b=req.body;
      if(typeof b.name!=='string'||!b.name.trim()||b.name.length>120||typeof b[field]!=='string'||!b[field].trim()||b[field].length>30||typeof b.active!=='boolean') fail('Tên, biển số/điện thoại hoặc trạng thái không hợp lệ.');
      const result=await db.withTransaction(async c=>{
        await lock(c);
        if(req.params.id) {
          if(!(await c.query(`SELECT 1 FROM ${table} WHERE id=$1`,[req.params.id])).rows.length) fail('Không tìm thấy dữ liệu.',404);
          if(!b.active) {
            const column=kind==='fleet'?'vehicle_id':'driver_id';
            if((await c.query(`SELECT 1 FROM vehicle_assignments a JOIN vehicle_bookings b ON b.id=a.booking_id WHERE a.${column}=$1 AND b.status='approved' AND b.booking_date >= $2`,[req.params.id,todayVN()])).rows.length) fail('Hãy hủy lịch đã duyệt trước khi ngừng hoạt động.',409);
            if(kind==='fleet' && (await c.query(`SELECT 1 FROM vehicle_bookings WHERE booking_date >= $1 AND status IN ('pending','approved') GROUP BY booking_date HAVING SUM(quantity) > (SELECT COUNT(*) FROM vehicle_fleet WHERE active AND id<>$2)`,[todayVN(),req.params.id])).rows.length) fail('Số xe còn lại không đủ cho các yêu cầu đang giữ chỗ.',409);
          }
          return (await c.query(`UPDATE ${table} SET name=$2,${field}=$3,active=$4 WHERE id=$1 RETURNING *`,[req.params.id,b.name.trim(),b[field].trim(),b.active])).rows[0];
        }
        return (await c.query(`INSERT INTO ${table}(name,${field},active) VALUES($1,$2,$3) RETURNING *`,[b.name.trim(),b[field].trim(),b.active])).rows[0];
      });
      res.status(req.params.id?200:201).json(result);
    });
    r.post('/api/vehicles/'+kind,requireAdmin,save);
    r.put('/api/vehicles/'+kind+'/:id',requireAdmin,save);
  }
  r.delete('/api/vehicles/fleet/:id',requireAdmin,route(async(req,res)=>{
    await db.withTransaction(async c=>{
      await lock(c);
      const vehicle=(await c.query('SELECT id FROM vehicle_fleet WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if(!vehicle) fail('Không tìm thấy xe.',404);
      if((await c.query('SELECT 1 FROM vehicle_assignments WHERE vehicle_id=$1 LIMIT 1',[vehicle.id])).rows.length) fail('Xe đã có lịch phân công, không thể xóa để giữ lịch sử. Hãy ngừng hoạt động xe sau khi xử lý các lịch còn hiệu lực.',409);
      if((await c.query(`SELECT 1 FROM vehicle_bookings WHERE booking_date >= $1 AND status IN ('pending','approved') GROUP BY booking_date HAVING SUM(quantity) > (SELECT COUNT(*) FROM vehicle_fleet WHERE active AND id<>$2)`,[todayVN(),vehicle.id])).rows.length) fail('Không thể xóa: số xe còn lại không đủ cho các yêu cầu đang giữ chỗ.',409);
      await c.query('DELETE FROM vehicle_fleet WHERE id=$1',[vehicle.id]);
    });
    await logActivity(req,'DELETE_VEHICLE',Number(req.params.id));
    res.json({ok:true});
  }));
  r.delete('/api/vehicles/drivers/:id',requireAdmin,route(async(req,res)=>{
    await db.withTransaction(async c=>{
      await lock(c);
      const driver=(await c.query('SELECT id FROM vehicle_drivers WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if(!driver) fail('Không tìm thấy tài xế.',404);
      if((await c.query('SELECT 1 FROM vehicle_assignments WHERE driver_id=$1 LIMIT 1',[driver.id])).rows.length) fail('Tài xế đã có lịch phân công, không thể xóa để giữ lịch sử. Hãy ngừng hoạt động tài xế sau khi xử lý các lịch còn hiệu lực.',409);
      await c.query('DELETE FROM vehicle_drivers WHERE id=$1',[driver.id]);
    });
    await logActivity(req,'DELETE_VEHICLE_DRIVER',Number(req.params.id));
    res.json({ok:true});
  }));
  r.get('/api/vehicles/access',requireAdmin,route(async(req,res)=>{
    res.json((await db.query(`SELECT u.id,u.name,u.email,EXISTS(SELECT 1 FROM vehicle_approvers a WHERE a.user_id=u.id) AS approver FROM users u WHERE u.status='active' ORDER BY u.name`)).rows);
  }));
  r.put('/api/vehicles/access/:id',requireAdmin,route(async(req,res)=>{
    if(typeof req.body.approver!=='boolean') fail('Quyền duyệt không hợp lệ.');
    if(req.body.approver) await db.query('INSERT INTO vehicle_approvers(user_id) VALUES($1) ON CONFLICT DO NOTHING',[req.params.id]);
    else await db.query('DELETE FROM vehicle_approvers WHERE user_id=$1',[req.params.id]);
    res.json({ok:true});
  }));
  return r;
};
