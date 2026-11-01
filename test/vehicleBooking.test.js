const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const routes = require('../src/routes/vehicles.routes');
const { validateRequest, validateAssignments } = require('../src/services/vehicleRules');
const { todayVN } = require('../src/services/bookingRules');
const payload = {booking_date:todayVN(),quantity:1,departure_point:'Office',departure_time:'07:30',destination:'Factory',purpose:'Visit',phone:'0901234567'};
test('management list restricts users and scopes unassigned managers to their own requests',async()=>{
  for(const role of ['user','manager','admin']) {
    let listed=false;
    const db={query:async(sql,params)=>{
      if(sql.includes('vehicle_approvers'))return {rows:[]};
      listed=true;
      assert.match(sql,/b.booking_date BETWEEN \$1 AND \$2/);
      assert.match(sql,/\(\$3::boolean OR b.created_by=\$4\)/);
      assert.deepEqual(params,['2030-01-01','2030-01-31',role==='admin',1]);
      return {rows:[]};
    }};
    const result=await request(db,'/api/vehicles/bookings?from=2030-01-01&to=2030-01-31',null,{id:1,role},'GET');
    assert.equal(result.status,role==='user'?403:200);
    assert.equal(listed,role!=='user');
  }
});

test('management list rejects reversed, invalid and excessively wide date ranges',async()=>{
  const db={query:async()=>{throw new Error('Invalid range must not query bookings');}};
  for(const range of ['from=2030-01-02&to=2030-01-01','from=2030-02-30&to=2030-03-01','from=2030-01-01&to=2031-01-02']) {
    const result=await request(db,'/api/vehicles/bookings?'+range,null,{id:1,role:'admin'},'GET');
    assert.equal(result.status,400);
  }
});
async function request(db, path, body, user={id:1,role:'user'}, method='POST') {
  const app=express(); app.use(express.json());
  app.use(routes({db,authMiddleware:(req,res,next)=>{req.user=user;next();},requireAdmin:(req,res,next)=>user.role==='admin'?next():res.status(403).json({message:'Forbidden'}),handleServerError:(res,e)=>res.status(500).json({message:e.message}),logActivity:async()=>{}}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  } finally { await new Promise(resolve=>server.close(resolve)); }
}
test('vehicle request rejects invalid dates, quantities and missing contacts',()=>{
  validateRequest(payload);
  for(const patch of [{booking_date:'2026-02-30'},{booking_date:'2000-01-01'},{quantity:0},{quantity:1.5},{quantity:'1'},{phone:''},{purpose:' '},{destination:'a'.repeat(501)}]) assert.throws(()=>validateRequest({...payload,...patch}));
});
test('approval requires a distinct vehicle and driver for each requested vehicle',()=>{
  validateAssignments([{vehicle_id:1,driver_id:1},{vehicle_id:2,driver_id:2}],2);
  for(const assignments of [[],[{vehicle_id:1,driver_id:1}], [{vehicle_id:1,driver_id:1},{vehicle_id:1,driver_id:2}],[{vehicle_id:1,driver_id:1},{vehicle_id:2,driver_id:1}], [null,null]]) assert.throws(()=>validateAssignments(assignments,2));
});

test('departure fields are required and departure time must be a valid minute of the day',()=>{
  for (const departure_time of ['00:00','23:59']) validateRequest({...payload,departure_time});
  for (const patch of [
    {departure_point:undefined},{departure_point:' '},{departure_point:'a'.repeat(501)},
    {departure_time:undefined},{departure_time:''},{departure_time:'24:00'},
    {departure_time:'12:60'},{departure_time:'7:30'},{departure_time:'07:30:00'},
  ]) assert.throws(()=>validateRequest({...payload,...patch}));
});

test('booking creation persists departure information',async()=>{
  const db={withTransaction:fn=>fn({query:async(sql,params)=>{
    if(sql.includes('pg_advisory')) return {rows:[]};
    if(sql.includes('AS total')) return {rows:[{total:2,reserved:0}]};
    assert.match(sql,/departure_point,departure_time/);
    assert.deepEqual(params.slice(6),['Office','07:30']);
    return {rows:[{id:1,departure_point:params[6],departure_time:params[7]}]};
  }})};
  const result=await request(db,'/api/vehicles/bookings',{...payload,departure_point:' Office '});
  assert.equal(result.status,201);
  assert.equal(result.body.departure_point,'Office');
  assert.equal(result.body.departure_time,'07:30');
});
test('concurrent requests cannot exceed the fleet capacity',async()=>{
  let reserved=0, sequence=Promise.resolve();
  const c={query:async sql=>{
    if(sql.includes('pg_advisory')) return {rows:[]};
    if(sql.includes('AS total')) return {rows:[{total:1,reserved}]};
    assert.match(sql,/INSERT INTO vehicle_bookings/); reserved++; return {rows:[{id:reserved}]};
  }};
  const db={withTransaction:fn=>{
    const result=sequence.then(()=>fn(c)); sequence=result.catch(()=>{}); return result;
  }};
  const results=await Promise.all([request(db,'/api/vehicles/bookings',payload),request(db,'/api/vehicles/bookings',payload)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]); assert.equal(reserved,1);
});
test('ordinary users cannot approve requests or cancel another owner request',async()=>{
  const db={withTransaction:fn=>fn({query:async sql=>({rows:sql.includes('FROM vehicle_bookings')?[{id:9,created_by:2,status:'pending',booking_date:todayVN(),quantity:1}]:[]})})};
  for(const action of ['approve','cancel']) {
    const result=await request(db,'/api/vehicles/bookings/9',{action,reason:'Changed'},undefined,'PATCH');
    assert.equal(result.status,403);
  }
});
test('approval rejects an already assigned vehicle or driver',async()=>{
  const db={withTransaction:fn=>fn({query:async sql=>{
    if(sql.includes('pg_advisory')) return {rows:[]};
    if(sql.includes('FOR UPDATE')) return {rows:[{id:9,created_by:2,status:'pending',booking_date:todayVN(),quantity:1}]};
    if(sql.includes('SELECT 1')) return {rows:[{}]};
    throw new Error('Must not insert conflicting assignments');
  }})};
  const result=await request(db,'/api/vehicles/bookings/9',{action:'approve',assignments:[{vehicle_id:1,driver_id:1}]},{id:1,role:'admin'},'PATCH');
  assert.equal(result.status,409);
});
test('fleet reduction cannot strand pending reservations',async()=>{
  const db={withTransaction:fn=>fn({query:async sql=>{
    if(sql.includes('FROM vehicle_fleet WHERE id=')) return {rows:[{}]};
    if(sql.includes('GROUP BY booking_date')) return {rows:[{}]};
    if(sql.startsWith('UPDATE')) throw new Error('Must not reduce capacity');
    return {rows:[]};
  }})};
  const result=await request(db,'/api/vehicles/fleet/1',{name:'Car',plate:'ABC',active:false},{id:1,role:'admin'},'PUT');
  assert.equal(result.status,409);
});
test('ordinary calendar returns only owned requests and no fleet or driver catalog',async()=>{
  const db={query:async(sql,params)=>{
    if(sql.includes('vehicle_approvers'))return {rows:[]};
    if(sql.includes('AS total'))return {rows:[{total:2,reserved:1}]};
    assert.match(sql,/\(\$2::boolean OR b.created_by=\$3\)/);
    assert.deepEqual(params,[todayVN(),false,1]); return {rows:[]};
  }};
  const result=await request(db,'/api/vehicles/day',null,undefined,'GET');
  assert.equal(result.status,200);assert.equal(result.body.remaining,1);assert.deepEqual(result.body.fleet,[]);assert.deepEqual(result.body.drivers,[]);
});
test('weekly calendar returns availability without exposing other users trips',async()=>{
  const db={query:async(sql,params)=>{
    if(sql.includes('vehicle_approvers'))return {rows:[]};
    assert.match(sql,/generate_series/);
    assert.match(sql,/\(\$3::boolean OR b.created_by=\$4\)/);
    assert.deepEqual(params,['2030-01-07','2030-01-13',false,1]);
    return {rows:[{date:'2030-01-07',total:3,reserved:2,bookings:[]},{date:'2030-01-08',total:3,reserved:0,bookings:[]}]};
  }};
  const result=await request(db,'/api/vehicles/calendar?from=2030-01-07&to=2030-01-13',null,undefined,'GET');
  assert.equal(result.status,200);
  assert.deepEqual(result.body.days.map(d=>d.remaining),[1,3]);
  assert.deepEqual(result.body.days[0].bookings,[]);
});
test('weekly calendar rejects invalid and excessively wide ranges before querying',async()=>{
  const db={query:async()=>{throw new Error('Must not query invalid calendar range');}};
  for(const range of ['from=2030-01-13&to=2030-01-07','from=2030-01-01&to=2030-03-01','from=2030-02-30&to=2030-03-01']) {
    assert.equal((await request(db,'/api/vehicles/calendar?'+range,null,undefined,'GET')).status,400);
  }
});
test('vehicle deletion checks history and capacity before removing a vehicle',async()=>{
  for(const scenario of ['available','assigned','reserved','missing']) {
    let removed=false;
    const db={withTransaction:fn=>fn({query:async sql=>{
      if(sql.includes('pg_advisory'))return {rows:[]};
      if(sql.includes('FOR UPDATE'))return {rows:scenario==='missing'?[]:[{id:4}]};
      if(sql.includes('FROM vehicle_assignments'))return {rows:scenario==='assigned'?[{}]:[]};
      if(sql.includes('GROUP BY booking_date'))return {rows:scenario==='reserved'?[{}]:[]};
      assert.match(sql,/DELETE FROM vehicle_fleet/);removed=true;return {rows:[]};
    }})};
    const result=await request(db,'/api/vehicles/fleet/4',{}, {id:1,role:'admin'},'DELETE');
    assert.equal(result.status,scenario==='available'?200:scenario==='missing'?404:409);
    assert.equal(removed,scenario==='available');
  }
});
test('only administrators can delete a vehicle',async()=>{
  const db={withTransaction:()=>{throw new Error('Must not access database');}};
  for(const role of ['user','manager']) {
    const result=await request(db,'/api/vehicles/fleet/4',{}, {id:1,role},'DELETE');
    assert.equal(result.status,403);
  }
});
test('driver deletion preserves assignment history and handles missing drivers',async()=>{
  for(const scenario of ['available','assigned','missing']) {
    let removed=false;
    const db={withTransaction:fn=>fn({query:async sql=>{
      if(sql.includes('pg_advisory'))return {rows:[]};
      if(sql.includes('FOR UPDATE'))return {rows:scenario==='missing'?[]:[{id:7}]};
      if(sql.includes('FROM vehicle_assignments')){
        assert.match(sql,/driver_id=\$1/);
        return {rows:scenario==='assigned'?[{}]:[]};
      }
      assert.match(sql,/DELETE FROM vehicle_drivers/);removed=true;return {rows:[]};
    }})};
    const result=await request(db,'/api/vehicles/drivers/7',{}, {id:1,role:'admin'},'DELETE');
    assert.equal(result.status,scenario==='available'?200:scenario==='missing'?404:409);
    assert.equal(removed,scenario==='available');
  }
});
test('only administrators can delete drivers',async()=>{
  const db={withTransaction:()=>{throw new Error('Must not access database');}};
  for(const role of ['user','manager']) {
    assert.equal((await request(db,'/api/vehicles/drivers/7',{}, {id:1,role},'DELETE')).status,403);
  }
});
