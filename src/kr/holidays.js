const {XMLParser,XMLValidator} = require('fast-xml-parser');
const fixtures = require('../../fixtures/01_holidays.json');
const endpoint = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
const unavailable = () => Object.assign(new Error('공휴일 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'),{status:503});
const validMonth = month => typeof month==='string' && /^(20\d{2})-(0[1-9]|1[0-2])$/.test(month);
const validDate = date => typeof date==='string' && /^20\d{2}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;

function normalize(data,month) {
  const {header,body} = data?.response || {};
  if(String(header?.resultCode)!=='00' || !body) throw unavailable();
  const raw=body.items?.item;
  const items=raw ? (Array.isArray(raw)?raw:[raw]) : [];
  if(!/^\d+$/.test(String(body.totalCount)) || Number(body.totalCount)!==items.length) throw unavailable();
  return items.map(item=>{
    const compact=String(item.locdate);
    const date=`${compact.slice(0,4)}-${compact.slice(4,6)}-${compact.slice(6,8)}`;
    if(!validDate(date) || date.slice(0,7)!==month || !['Y','N'].includes(item.isHoliday) || typeof item.dateName!=='string' || !item.dateName.trim()) throw unavailable();
    return {date,name:item.dateName,isHoliday:item.isHoliday==='Y'};
  }).filter(item=>item.isHoliday);
}

function createHolidays({redis,serviceKey=process.env.DATA_GO_KR_SERVICE_KEY || '',fetchImpl=globalThis.fetch,timeoutMs=5000}={}) {
  const mode=serviceKey.trim()?'live':'mock';
  async function getMonth(month) {
    if(!validMonth(month)) throw Object.assign(new Error('month는 YYYY-MM 형식(2000~2099)으로 보내 주세요.'),{status:400});
    if(mode==='mock') {
      if(!fixtures[month]) throw unavailable();
      return {mode,holidays:normalize(fixtures[month],month)};
    }
    const cacheKey=`kr:holidays:live:v1:${month}`;
    try {
      const cached=await redis?.get(cacheKey);
      if(cached) return {mode,holidays:normalize(JSON.parse(cached),month)};
    } catch { /* Invalid cache entries are fetched again. */ }
    const controller=new AbortController();
    let timer;
    try {
      const url=new URL(endpoint);
      url.search=new URLSearchParams({ServiceKey:serviceKey,solYear:month.slice(0,4),solMonth:month.slice(5),pageNo:'1',numOfRows:'100'}).toString();
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},timeoutMs);});
      const data=await Promise.race([(async()=>{
        const response=await fetchImpl(url,{signal:controller.signal,redirect:'error'});
        if(!response.ok) throw unavailable();
        const text=await response.text();
        if(/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text)!==true) throw unavailable();
        return new XMLParser({parseTagValue:false}).parse(text);
      })(),timeout]);
      const holidays=normalize(data,month);
      try {await redis?.set(cacheKey,JSON.stringify(data),{EX:86400});} catch { /* Holiday validation still uses the upstream response. */ }
      return {mode,holidays};
    } catch {throw unavailable();} finally {clearTimeout(timer);}
  }
  async function pickupDays(month) {
    const {holidays}=await getMonth(month);
    const days=[];
    const count=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate();
    for(let day=1;day<=count;day++) {
      const date=`${month}-${String(day).padStart(2,'0')}`;
      const holiday=holidays.find(item=>item.date===date);
      const weekend=[0,6].includes(new Date(date+'T00:00:00Z').getUTCDay());
      days.push({date,available:!holiday&&!weekend,reason:holiday?.name || (weekend?'주말':null)});
    }
    return {month,mode,days};
  }
  async function checkPickup(date) {
    if(!validDate(date)) throw Object.assign(new Error('pickupDate는 유효한 YYYY-MM-DD 날짜로 보내 주세요.'),{status:400});
    let calendar=await pickupDays(date.slice(0,7));
    const requested=calendar.days.find(day=>day.date===date);
    if(requested.available) return {...requested,mode,nextAvailableDate:null};
    const cursor=new Date(date+'T00:00:00Z');
    for(let offset=1;offset<=31;offset++) {
      cursor.setUTCDate(cursor.getUTCDate()+1);
      const candidate=cursor.toISOString().slice(0,10);
      if(candidate.slice(0,7)!==calendar.month) calendar=await pickupDays(candidate.slice(0,7));
      if(calendar.days.find(day=>day.date===candidate)?.available) return {...requested,mode,nextAvailableDate:candidate};
    }
    throw unavailable();
  }
  return {getMonth,pickupDays,checkPickup};
}
module.exports = {createHolidays};
