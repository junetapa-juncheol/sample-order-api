const {XMLBuilder} = require('fast-xml-parser');
const {createHolidays} = require('../src/kr/holidays');
const fixtures = require('../fixtures/01_holidays.json');
const xml=data=>new XMLBuilder().build(data);
const reply=data=>({ok:true,text:async()=>xml(data)});
const live=(fetchImpl,extra={})=>createHolidays({serviceKey:'test-only',fetchImpl,...extra});

test('no key uses fixtures without a network request',async()=>{
  const fetchImpl=jest.fn(()=>{throw Error('network forbidden');});
  const calendar=await createHolidays({serviceKey:'',fetchImpl}).pickupDays('2026-12');
  expect(calendar.mode).toBe('mock');
  expect(calendar.days).toHaveLength(31);
  expect(calendar.days.find(day=>day.date==='2026-12-25')).toEqual({date:'2026-12-25',available:false,reason:'기독탄신일'});
  expect(fetchImpl).not.toHaveBeenCalled();
});
test('holiday and weekend suggest the next weekday',async()=>{
  const holidays=createHolidays({serviceKey:''});
  expect(await holidays.checkPickup('2026-12-25')).toMatchObject({available:false,nextAvailableDate:'2026-12-28'});
  expect(await holidays.checkPickup('2027-01-01')).toMatchObject({available:false,nextAvailableDate:'2027-01-04'});
  expect(await holidays.checkPickup('2026-12-26')).toMatchObject({available:false,nextAvailableDate:'2026-12-28'});
  expect(await holidays.checkPickup('2026-12-24')).toMatchObject({available:true,nextAvailableDate:null});
});
test.each(['2026-13','2026-00','26-12','2026-12-01',undefined,['2026-12']])('invalid month %p is rejected',async month=>{
  await expect(createHolidays({serviceKey:''}).pickupDays(month)).rejects.toMatchObject({status:400});
});
test.each(['2026-02-30','2026-12-32','2026-1-01'])('invalid date %s is rejected',async date=>{
  await expect(createHolidays({serviceKey:''}).checkPickup(date)).rejects.toMatchObject({status:400});
});
test('unknown mock month is unavailable rather than treated as a working month',async()=>{
  await expect(createHolidays({serviceKey:''}).pickupDays('2028-12')).rejects.toMatchObject({status:503});
});
test('live mode parses XML, requests the official operation and caches for a day',async()=>{
  const cache=new Map();
  const redis={get:jest.fn(async key=>cache.get(key)),set:jest.fn(async(key,value)=>cache.set(key,value))};
  const fetchImpl=jest.fn(async()=>reply(fixtures['2026-12']));
  const holidays=live(fetchImpl,{redis});
  expect((await holidays.pickupDays('2026-12')).mode).toBe('live');
  await holidays.pickupDays('2026-12');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url,options]=fetchImpl.mock.calls[0];
  expect(url.origin+url.pathname).toBe('https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo');
  expect(url.searchParams.get('solYear')).toBe('2026');
  expect(url.searchParams.get('solMonth')).toBe('12');
  expect(url.searchParams.get('numOfRows')).toBe('100');
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(redis.set).toHaveBeenCalledWith('kr:holidays:live:v1:2026-12',expect.any(String),{EX:86400});
});
test('a single XML item and an empty month are supported',async()=>{
  const single={response:{header:{resultCode:'00'},body:{totalCount:1,items:{item:{locdate:20261225,dateName:'기독탄신일',isHoliday:'Y'}}}}};
  expect((await live(async()=>reply(single)).getMonth('2026-12')).holidays).toHaveLength(1);
  const empty={response:{header:{resultCode:'00'},body:{totalCount:0,items:''}}};
  expect((await live(async()=>reply(empty)).getMonth('2026-12')).holidays).toEqual([]);
});
test.each([
  ['network rejection',async()=>{throw Error('offline');}],
  ['HTTP error',async()=>({ok:false})],
  ['malformed XML',async()=>({ok:true,text:async()=>'<response>'})],
  ['gateway XML error',async()=>({ok:true,text:async()=>'<OpenAPI_ServiceResponse><returnReasonCode>30</returnReasonCode></OpenAPI_ServiceResponse>'})],
  ['upstream result code',async()=>reply({response:{header:{resultCode:'30'},body:{totalCount:0}}})],
  ['missing totalCount',async()=>reply({response:{header:{resultCode:'00'},body:{items:''}}})],
  ['truncated results',async()=>reply({response:{header:{resultCode:'00'},body:{totalCount:10,items:''}}})],
  ['invalid holiday fields',async()=>reply({response:{header:{resultCode:'00'},body:{totalCount:1,items:{item:{locdate:20261225,isHoliday:'Y'}}}}})]
])('%s returns 503 without falling back to fixtures',async(_name,fetchImpl)=>{
  const redis={get:async()=>null,set:jest.fn()};
  await expect(live(fetchImpl,{redis}).getMonth('2026-12')).rejects.toMatchObject({status:503});
  expect(redis.set).not.toHaveBeenCalled();
});
test('timeout covers response body and aborts the request',async()=>{
  let signal;
  const fetchImpl=async(_url,options)=>{signal=options.signal;return {ok:true,text:()=>new Promise(()=>{})};};
  await expect(live(fetchImpl,{timeoutMs:10}).getMonth('2026-12')).rejects.toMatchObject({status:503});
  expect(signal.aborted).toBe(true);
});
test('Redis failures and corrupt cached data still use a successful upstream response',async()=>{
  const fetchImpl=jest.fn(async()=>reply(fixtures['2026-12']));
  for(const cached of ['broken json',JSON.stringify({response:{}})]) {
    const redis={get:async()=>cached,set:async()=>{throw Error('offline');}};
    expect((await live(fetchImpl,{redis}).getMonth('2026-12')).holidays).toHaveLength(5);
  }
  const redis={get:async()=>{throw Error('offline');}};
  expect((await live(fetchImpl,{redis}).getMonth('2026-12')).mode).toBe('live');
});
test('next business day crosses the year boundary',async()=>{
  const december=structuredClone(fixtures['2026-12']);
  december.response.body.items.item.push({locdate:20261231,dateName:'표본 휴일',isHoliday:'Y',dateKind:'01',seq:1});
  december.response.body.totalCount++;
  const fetchImpl=jest.fn(async url=>reply(url.searchParams.get('solMonth')==='12'?december:fixtures['2027-01']));
  expect(await live(fetchImpl).checkPickup('2026-12-31')).toMatchObject({nextAvailableDate:'2027-01-04'});
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
