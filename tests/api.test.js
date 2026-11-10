const request = require('supertest');
const {connect} = require('../src/connections');
const {migrate} = require('../src/migrate');
const {createApp} = require('../src/app');
const {createMailSink} = require('../src/mail');
const {flushOutbox} = require('../src/outbox');
jest.setTimeout(30000);
let deps, app;
const payload={items:[{productId:1,quantity:2}]};
const place=(key='request-test-001',data=payload)=>request(app).post('/api/orders').set('Idempotency-Key',key).send(data);
beforeAll(async()=>{
  deps=await connect();
  await migrate(deps.pg);
  deps.mail=await createMailSink(0);
  app=createApp(deps);
});
beforeEach(async()=>{
  await deps.pg.query('TRUNCATE order_outbox,order_items,orders');
  await deps.pg.query('UPDATE products SET stock=36');
  await deps.events.deleteMany({});
  await deps.redis.del('products:v1');
  deps.mail.receipts.length=0;
});
afterAll(async()=>{if(deps){await deps.mail?.close();await deps.close();}});
test('health checks three services',async()=>{
  expect((await request(app).get('/api/health')).body).toEqual({status:'ok'});
});
test('products cache MISS then HIT, with expiry',async()=>{
  const first=await request(app).get('/api/products');
  expect(first.headers['x-cache']).toBe('MISS');
  expect(first.body).toHaveLength(4);
  expect((await request(app).get('/api/products')).headers['x-cache']).toBe('HIT');
  expect(await deps.redis.ttl('products:v1')).toBeGreaterThan(0);
});
test('order commits SQL, invalidates cache, records Mongo event and sinks SMTP',async()=>{
  await request(app).get('/api/products');
  const response=await place();
  expect(response.status).toBe(201);
  expect(response.body.total).toBe(6400);
  expect(await deps.redis.get('products:v1')).toBeNull();
  expect((await deps.pg.query('SELECT stock FROM products WHERE id=1')).rows[0].stock).toBe(34);
  const history=await request(app).get(`/api/orders/${response.body.id}/history`);
  expect(history.body[0].kind).toBe('order.received');
  expect(deps.mail.receipts).toHaveLength(1);
  expect(deps.mail.receipts[0].bytes).toBeGreaterThan(100);
});
test('idempotent replay does not reduce stock or send twice',async()=>{
  const first=await place();const second=await place();
  expect(second.status).toBe(200);expect(second.body.id).toBe(first.body.id);
  expect(second.body.replayed).toBe(true);
  expect(deps.mail.receipts).toHaveLength(1);
  expect((await deps.pg.query('SELECT stock FROM products WHERE id=1')).rows[0].stock).toBe(34);
});
test('same key with a different payload is rejected',async()=>{
  await place();
  expect((await place('request-test-001',{items:[{productId:1,quantity:3}]})).status).toBe(409);
});
test('concurrent duplicate requests create one order',async()=>{
  const replies=await Promise.all([place(),place(),place()]);
  expect(replies.map(r=>r.status).sort()).toEqual([200,200,201]);
  expect((await deps.pg.query('SELECT count(*) FROM orders')).rows[0].count).toBe('1');
});
test('invalid quantity, missing key, duplicate product, and extra personal field rejected',async()=>{
  expect((await place('request-test-001',{items:[{productId:1,quantity:0}]})).status).toBe(400);
  expect((await request(app).post('/api/orders').send(payload)).status).toBe(400);
  expect((await place('request-test-001',{items:[{productId:1,quantity:1},{productId:1,quantity:1}]})).status).toBe(400);
  expect((await place('request-test-001',{...payload,customer:'not accepted'})).status).toBe(400);
});
test('missing product rolls back earlier stock deductions',async()=>{
  const result=await place('request-test-001',{items:[{productId:1,quantity:2},{productId:99,quantity:1}]});
  expect(result.status).toBe(404);
  expect((await deps.pg.query('SELECT stock FROM products WHERE id=1')).rows[0].stock).toBe(36);
  expect((await deps.pg.query('SELECT count(*) FROM orders')).rows[0].count).toBe('0');
});
test('concurrent orders cannot oversell',async()=>{
  await deps.pg.query('UPDATE products SET stock=2 WHERE id=1');
  const results=await Promise.all([place('parallel-order-a'),place('parallel-order-b')]);
  expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  expect((await deps.pg.query('SELECT stock FROM products WHERE id=1')).rows[0].stock).toBe(0);
});
test('status changes follow the workflow and persist history',async()=>{
  const {body}=await place();
  expect((await request(app).patch(`/api/orders/${body.id}/status`).send({status:'ready'})).status).toBe(409);
  for(const status of ['preparing','ready','collected']) {
    const reply=await request(app).patch(`/api/orders/${body.id}/status`).send({status});
    expect(reply.status).toBe(200);expect(reply.body.status).toBe(status);
  }
  const history=await request(app).get(`/api/orders/${body.id}/history`);
  expect(history.body).toHaveLength(4);
  expect((await request(app).get('/api/orders')).body[0].status).toBe('collected');
});
test('invalid UUID, malformed JSON, unknown route and missing history handled',async()=>{
  expect((await request(app).get('/api/orders/nope/history')).status).toBe(400);
  expect((await request(app).get('/api/orders/00000000-0000-4000-8000-000000000001/history')).status).toBe(404);
  expect((await request(app).post('/api/orders').set('Content-Type','application/json').send('{')).status).toBe(400);
  expect((await request(app).get('/missing')).status).toBe(404);
});
test('SQL outbox survives Mongo failure and retry delivers the event',async()=>{
  const failed={...deps,events:{updateOne:async()=>{throw Error('offline');}}};
  const warning=jest.spyOn(console,'warn').mockImplementation(()=>{});
  const res=await request(createApp(failed)).post('/api/orders').set('Idempotency-Key','outbox-failure-001').send(payload);
  expect(res.status).toBe(201);
  expect((await deps.pg.query('SELECT delivered FROM order_outbox')).rows[0].delivered).toBe(false);
  await flushOutbox(deps);
  expect(await deps.events.countDocuments({orderId:res.body.id})).toBe(1);
  expect(deps.mail.receipts).toHaveLength(1);
  warning.mockRestore();
});

test('pickup calendar uses mock data without a key',async()=>{
  const response=await request(app).get('/api/pickup-days?month=2026-12');
  expect(response.status).toBe(200);
  expect(response.body.mode).toBe('mock');
  expect(response.body.days.find(day=>day.date==='2026-12-25').available).toBe(false);
  expect((await request(app).get('/api/pickup-days?month=2026-13')).status).toBe(400);
  expect((await request(app).get('/api/pickup-days')).status).toBe(400);
  expect((await request(app).get('/api/pickup-days?month=2028-12')).status).toBe(503);
});
test('holiday rejection suggests Monday without changing stock or writing events',async()=>{
  const response=await place('pickup-holiday-001',{...payload,pickupDate:'2026-12-25'});
  expect(response.status).toBe(409);
  expect(response.body.nextAvailableDate).toBe('2026-12-28');
  expect((await deps.pg.query('SELECT stock FROM products WHERE id=1')).rows[0].stock).toBe(36);
  expect((await deps.pg.query('SELECT count(*) FROM orders')).rows[0].count).toBe('0');
  expect(await deps.events.countDocuments({})).toBe(0);
  expect(deps.mail.receipts).toHaveLength(0);
});
test('pickup date persists in orders, history and idempotent replay',async()=>{
  const dated={...payload,pickupDate:'2026-12-28'};
  const first=await place('pickup-open-001',dated);
  expect(first.status).toBe(201);expect(first.body.pickupDate).toBe('2026-12-28');
  const replay=await place('pickup-open-001',dated);
  expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);
  expect((await request(app).get('/api/orders')).body[0].pickupDate).toBe('2026-12-28');
  const history=await request(app).get(`/api/orders/${first.body.id}/history`);
  expect(history.body[0].pickupDate).toBe('2026-12-28');
  expect(deps.mail.receipts).toHaveLength(1);
  expect((await place('pickup-open-001',{...payload,pickupDate:'2026-12-29'})).status).toBe(409);
  expect((await place('pickup-open-001',payload)).status).toBe(409);
});
test('weekend and invalid pickup dates are rejected',async()=>{
  const weekend=await place('pickup-weekend-001',{...payload,pickupDate:'2026-12-26'});
  expect(weekend.status).toBe(409);expect(weekend.body.nextAvailableDate).toBe('2026-12-28');
  expect((await place('pickup-invalid-001',{...payload,pickupDate:'2026-02-30'})).status).toBe(400);
  expect((await place('pickup-invalid-001',{...payload,pickupDate:20261228})).status).toBe(400);
});
test('live failure gives 503 for calendar and order without accepting a holiday',async()=>{
  const {createHolidays}=require('../src/kr/holidays');
  const fetchImpl=jest.fn(async()=>{throw Error('offline');});
  const holidays=createHolidays({serviceKey:'test-only',fetchImpl,redis:deps.redis});
  await deps.redis.del('kr:holidays:live:v1:2026-12');
  const failed=createApp({...deps,holidays});
  expect((await request(failed).get('/api/pickup-days?month=2026-12')).status).toBe(503);
  const response=await request(failed).post('/api/orders').set('Idempotency-Key','pickup-live-error').send({...payload,pickupDate:'2026-12-28'});
  expect(response.status).toBe(503);
  expect((await deps.pg.query('SELECT count(*) FROM orders')).rows[0].count).toBe('0');
});
test('live calendar uses Redis for one day and saved orders replay during an outage',async()=>{
  const {XMLBuilder}=require('fast-xml-parser');
  const {createHolidays}=require('../src/kr/holidays');
  const fixture=require('../fixtures/01_holidays.json');
  await deps.redis.del('kr:holidays:live:v1:2026-12');
  const fetchImpl=jest.fn(async()=>({ok:true,text:async()=>new XMLBuilder().build(fixture['2026-12'])}));
  const holidays=createHolidays({serviceKey:'test-only',fetchImpl,redis:deps.redis});
  const liveApp=createApp({...deps,holidays});
  const dated={...payload,pickupDate:'2026-12-28'};
  const send=()=>request(liveApp).post('/api/orders').set('Idempotency-Key','pickup-live-replay').send(dated);
  expect((await send()).status).toBe(201);
  expect((await request(liveApp).get('/api/pickup-days?month=2026-12')).status).toBe(200);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(await deps.redis.ttl('kr:holidays:live:v1:2026-12')).toBeGreaterThan(86390);
  await deps.redis.del('kr:holidays:live:v1:2026-12');
  fetchImpl.mockRejectedValue(Error('offline'));
  const replay=await send();
  expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('pickup column migration is repeatable and preserves saved dates',async()=>{
  const first=await place('pickup-migrate-001',{...payload,pickupDate:'2026-12-28'});
  await migrate(deps.pg);await migrate(deps.pg);
  const row=(await deps.pg.query('SELECT pickup_date FROM orders WHERE id=$1',[first.body.id])).rows[0];
  expect(row.pickup_date).toBe('2026-12-28');
});
