const express = require('express');
const helmet = require('helmet');
const {randomUUID,randomInt} = require('node:crypto');
const {z} = require('zod');
const {flushOutbox} = require('./outbox');
const orderSchema = z.object({items:z.array(z.object({productId:z.number().int().positive(),quantity:z.number().int().min(1).max(20)}).strict()).min(1).max(10)}).strict();
const transitions = {received:'preparing',preparing:'ready',ready:'collected'};
const failure = (status,message) => Object.assign(new Error(message),{status});
const output = row => ({id:row.id,pickupCode:row.pickup_code,status:row.status,total:row.total,createdAt:row.created_at});

function createApp(deps) {
  const {pg,redis,events} = deps;
  const app = express();
  app.use(helmet());
  app.use(express.json({limit:'16kb'}));
  async function sync() {try {await flushOutbox(deps);} catch {console.warn('Outbox pending; retry scheduled');}}
  async function invalidate() {try {await redis.del('products:v1');} catch { /* Cache expires after 30 seconds. */ }}
  app.get('/api/health',async(_req,res)=>{
    try {await Promise.all([pg.query('SELECT 1'),deps.mongo.db('bakery').command({ping:1}),redis.ping()]);res.json({status:'ok'});}
    catch {res.status(503).json({status:'unavailable'});}
  });
  app.get('/api/products',async(_req,res)=>{
    try {
      const cached = await redis.get('products:v1');
      if(cached) return res.set('X-Cache','HIT').json(JSON.parse(cached));
    } catch { /* PostgreSQL remains the source of truth. */ }
    const {rows} = await pg.query('SELECT * FROM products ORDER BY id');
    try {await redis.set('products:v1',JSON.stringify(rows),{EX:30});res.set('X-Cache','MISS');} catch {res.set('X-Cache','BYPASS');}
    res.json(rows);
  });
  app.get('/api/orders',async(_req,res)=>{
    const {rows} = await pg.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100');
    res.json(rows.map(output));
  });
  app.post('/api/orders',async(req,res)=>{
    const parsed = orderSchema.safeParse(req.body);
    const key = req.get('Idempotency-Key');
    if (!parsed.success || !key || !/^[a-zA-Z0-9_-]{8,80}$/.test(key)) throw failure(400,'상품과 수량, 8~80자 Idempotency-Key를 확인해 주세요.');
    const items = parsed.data.items.sort((a,b)=>a.productId-b.productId);
    if(new Set(items.map(item=>item.productId)).size!==items.length) throw failure(400,'같은 상품은 한 번만 넣어 주세요.');
    const client = await pg.connect();
    let row;
    let replay=false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
      const previous = await client.query('SELECT * FROM orders WHERE request_key=$1',[key]);
      if(previous.rows.length) {
        row=previous.rows[0];replay=true;
        const saved = (await client.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1 ORDER BY product_id',[row.id])).rows;
        if(JSON.stringify(saved.map(i=>({productId:i.product_id,quantity:i.quantity})))!==JSON.stringify(items)) throw failure(409,'같은 요청 키에 다른 주문을 보낼 수 없습니다.');
      } else {
        let total=0;
        const prices=[];
        for(const item of items) {
          const product = (await client.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[item.productId])).rows[0];
          if(!product) throw failure(404,'상품이 없습니다.');
          if(product.stock<item.quantity) throw failure(409,'재고가 부족합니다.');
          total+=product.price*item.quantity;prices.push(product.price);
          await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[item.quantity,item.productId]);
        }
        row=(await client.query('INSERT INTO orders(id,pickup_code,request_key,total) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),String(randomInt(100000,1000000)),key,total])).rows[0];
        for(let i=0;i<items.length;i++) await client.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price) VALUES($1,$2,$3,$4)',[row.id,items[i].productId,items[i].quantity,prices[i]]);
        await client.query('INSERT INTO order_outbox(id,order_id,kind,payload) VALUES($1,$2,$3,$4)',[randomUUID(),row.id,'order.received',JSON.stringify(output(row))]);
      }
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    await invalidate();await sync();
    res.status(replay?200:201).json({...output(row),replayed:replay});
  });
  app.patch('/api/orders/:id/status',async(req,res)=>{
    if(!z.uuid().safeParse(req.params.id).success || !z.object({status:z.enum(['preparing','ready','collected'])}).strict().safeParse(req.body).success) throw failure(400,'주문 ID와 상태를 확인해 주세요.');
    const client=await pg.connect();
    let row;
    try {
      await client.query('BEGIN');
      const current=(await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if(!current) throw failure(404,'주문이 없습니다.');
      if(transitions[current.status]!==req.body.status) throw failure(409,'다음 단계로만 변경할 수 있습니다.');
      row=(await client.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',[req.body.status,req.params.id])).rows[0];
      await client.query('INSERT INTO order_outbox(id,order_id,kind,payload) VALUES($1,$2,$3,$4)',[randomUUID(),row.id,'order.status',JSON.stringify(output(row))]);
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    await sync();res.json(output(row));
  });
  app.get('/api/orders/:id/history',async(req,res)=>{
    if(!z.uuid().safeParse(req.params.id).success) throw failure(400,'주문 ID를 확인해 주세요.');
    const exists=await pg.query('SELECT id FROM orders WHERE id=$1',[req.params.id]);
    if(!exists.rows.length) throw failure(404,'주문이 없습니다.');
    await sync();
    res.json(await events.find({orderId:req.params.id},{projection:{_id:0}}).sort({createdAt:1}).toArray());
  });
  app.use((_req,res)=>res.status(404).json({error:'경로가 없습니다.'}));
  app.use((error,_req,res,_next)=>res.status(error.status || 500).json({error:error.status ? (error.type==='entity.parse.failed'?'JSON 형식을 확인해 주세요.':error.message) : '요청을 처리하지 못했습니다.'}));
  return app;
}
module.exports = {createApp};
