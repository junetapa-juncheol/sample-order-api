const {readFile} = require('node:fs/promises');
const path = require('node:path');
const {Pool} = require('pg');
async function migrate(pg) {
  const sql = await readFile(path.join(__dirname,'../migrations/schema.sql'),'utf8');
  await pg.query(sql);
}
if (require.main === module) {
  const pg = new Pool({connectionString:process.env.DATABASE_URL || 'postgresql://bakery@127.0.0.1:5432/bakery'});
  migrate(pg).then(()=>console.log('Migration complete')).catch(()=>{console.error('Migration failed');process.exitCode=1;}).finally(()=>pg.end());
}
module.exports = {migrate};
