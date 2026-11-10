const path = require('node:path');
const express = require('express');
const {connect} = require('./connections');
const {migrate} = require('./migrate');
const {createMailSink} = require('./mail');
const {createApp} = require('./app');
const {flushOutbox} = require('./outbox');
async function start() {
  const deps = await connect();
  await migrate(deps.pg);
  deps.mail = await createMailSink(Number(process.env.SMTP_PORT || 2525));
  const app = express();
  app.use('/sample-order-api',express.static(path.join(__dirname,'../docs')));
  app.use(createApp(deps));
  const server = app.listen(Number(process.env.PORT || 3000),'0.0.0.0',()=>console.log('Order API listening'));
  const worker=setInterval(()=>flushOutbox(deps).catch(()=>console.warn('Outbox retry pending')),5000);
  async function stop() {
    clearInterval(worker);
    await new Promise(resolve=>server.close(resolve));
    await deps.mail.close();await deps.close();
  }
  process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));
  process.once('SIGINT',()=>stop().then(()=>process.exit(0)));
}
start().catch(()=>{console.error('Startup failed: check database services');process.exit(1);});
