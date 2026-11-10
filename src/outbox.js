async function flushOutbox({pg,events,mail}) {
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const {rows} = await client.query('SELECT * FROM order_outbox WHERE delivered=false ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 50');
    for (const event of rows) {
      await events.updateOne({eventId:event.id},{$setOnInsert:{eventId:event.id,orderId:event.order_id,kind:event.kind,...event.payload,createdAt:event.created_at}},{upsert:true});
      if (event.kind==='order.received') await mail.send(event.payload);
      await client.query('UPDATE order_outbox SET delivered=true WHERE id=$1',[event.id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {client.release();}
}
module.exports = {flushOutbox};
