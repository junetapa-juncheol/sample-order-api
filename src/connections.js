const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const { createClient } = require('redis');

async function connect() {
  const pg = new Pool({connectionString: process.env.DATABASE_URL || 'postgresql://bakery@127.0.0.1:5432/bakery', connectionTimeoutMillis:5000});
  const mongo = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017', {serverSelectionTimeoutMS:5000});
  const redis = createClient({url:process.env.REDIS_URL || 'redis://127.0.0.1:6379',socket:{connectTimeout:5000,reconnectStrategy:false}});
  redis.on('error', () => {});
  try {
    await Promise.all([pg.query('SELECT 1'),mongo.connect(),redis.connect()]);
    const events = mongo.db('bakery').collection('order_events');
    await events.createIndex({eventId:1},{unique:true});
    return {pg,mongo,redis,events,close:async()=>{await Promise.allSettled([pg.end(),mongo.close(),redis.isOpen ? redis.quit() : Promise.resolve()]);}};
  } catch (error) {
    await Promise.allSettled([pg.end(),mongo.close(),redis.isOpen ? redis.quit() : Promise.resolve()]);
    throw error;
  }
}
module.exports = {connect};
