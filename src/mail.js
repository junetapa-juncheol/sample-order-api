const {SMTPServer} = require('smtp-server');
const nodemailer = require('nodemailer');
async function createMailSink(port=2525) {
  const receipts = [];
  const server = new SMTPServer({
    disabledCommands:['AUTH','STARTTLS'], logger:false,
    onData(stream,_session,done) {
      let bytes=0;
      stream.on('data',chunk=>{bytes+=chunk.length;});
      stream.on('end',()=>{receipts.push({bytes});done();});
      stream.on('error',done);
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address = server.server.address();
  const transport = nodemailer.createTransport({host:'127.0.0.1',port:address.port,secure:false,ignoreTLS:true,connectionTimeout:5000});
  return {receipts,
    send:order=>transport.sendMail({from:'receipt@bakery.invalid',to:'preview@bakery.invalid',subject:`주문 ${order.pickupCode} 접수`,text:`픽업번호 ${order.pickupCode} · 합계 ${order.total}원`}),
    close:()=>new Promise(resolve=>server.close(resolve))};
}
module.exports = {createMailSink};
