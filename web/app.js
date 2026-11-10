import './style.css';
import holidayFixtures from '../fixtures/01_holidays.json';
const labels={received:'접수',preparing:'준비 중',ready:'픽업 대기',collected:'완료'};
const next={received:'preparing',preparing:'ready',ready:'collected'};
const actions={received:'준비 시작하기',preparing:'픽업 준비 완료',ready:'픽업 완료하기'};
const data=await fetch(`${import.meta.env.BASE_URL}samples.json`).then(r=>r.json());
let selected=data.orders[0].id;
let filter='all';
const money=n=>n.toLocaleString('ko-KR');
const el=id=>document.getElementById(id);
function announce(text){el('notice').textContent=text;}
function render(){
  const orders=data.orders.filter(o=>(filter==='all'||o.status===filter)&&o.pickupCode.includes(el('search').value.trim()));
  el('order-rows').innerHTML=orders.map(o=>`<tr class="${o.id===selected?'chosen':''}"><td><button class="order-link" data-id="${o.id}" aria-label="픽업 ${o.pickupCode} 상세">#${o.pickupCode}</button></td><td><b>${o.items[0].name}</b>${o.items.length>1?` <span class="muted">외 ${o.items.length-1}종</span>`:''}<small>총 ${o.items.reduce((s,i)=>s+i.quantity,0)}개</small></td><td>${money(o.total)}원</td><td class="muted">${o.time}</td><td><span class="status ${o.status}">${labels[o.status]}</span></td><td><button class="row-open" data-id="${o.id}" aria-label="${o.pickupCode} 선택">›</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty">조건에 맞는 주문이 없어요.</td></tr>';
  el('row-summary').textContent=`${orders.length}개의 주문`;
  el('nav-count').textContent=data.orders.length;el('list-count').textContent=data.orders.length;
  el('stat-total').innerHTML=`${data.orders.length}<small>건</small>`;
  el('stat-preparing').innerHTML=`${data.orders.filter(o=>o.status==='preparing').length}<small>건</small>`;
  el('stat-ready').innerHTML=`${data.orders.filter(o=>o.status==='ready').length}<small>건</small>`;
  el('stat-sales').innerHTML=`${money(data.orders.reduce((s,o)=>s+o.total,0))}<small>원</small>`;
  const o=data.orders.find(o=>o.id===selected);
  el('order-detail').innerHTML=`<div class="pickup"><span>픽업번호</span><strong>#${o.pickupCode}</strong><span class="status ${o.status}">${labels[o.status]}</span></div><p class="detail-caption">주문 내역 <span>${o.time} 접수</span></p><div class="detail-items">${o.items.map(i=>`<div><span>${i.name}<small>${i.quantity}개</small></span><b>${money(i.price*i.quantity)}원</b></div>`).join('')}</div><div class="detail-total"><span>합계</span><strong>${money(o.total)}<small>원</small></strong></div><div class="timeline"><span class="little-dot"></span><p>주문이 접수되었어요<small>${o.time} · 표본 주문</small></p></div>${next[o.status]?`<button class="primary full" id="advance">${actions[o.status]} <span>→</span></button>`:'<div class="done-message">✓ 픽업을 완료한 주문입니다</div>'}<p class="detail-hint">상태 변경은 이 미리보기에서만 적용됩니다.</p>`;
  el('advance')?.addEventListener('click',()=>{o.status=next[o.status];announce(`#${o.pickupCode} 주문이 ${labels[o.status]} 상태로 변경되었습니다.`);render();});
  document.querySelectorAll('[data-id]').forEach(b=>b.addEventListener('click',()=>{selected=b.dataset.id;render();}));
}
el('search').addEventListener('input',render);
document.querySelectorAll('.filter').forEach(button=>button.addEventListener('click',()=>{
  filter=button.dataset.status;document.querySelectorAll('.filter').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});render();
}));
el('new-order').addEventListener('click',()=>{
  const n=data.orders.length+1;
  data.orders.unshift({id:`demo-${n}`,pickupCode:String(1040+n),time:'방금',status:'received',total:6400,items:[{name:'소금 버터롤',quantity:2,price:3200}]});
  selected=data.orders[0].id;filter='all';el('search').value='';document.querySelector('[data-status="all"]').click();announce('표본 주문이 추가되었습니다.');
});
const symbols=['◒','◓','◰','◩'];
el('product-list').innerHTML=data.products.map((p,i)=>`<article class="product"><div class="bread-symbol tone-${i}" aria-hidden="true">${symbols[i]}</div><div><h3>${p.name}</h3><p>${p.category} <span>· ${money(p.price)}원</span></p></div><span class="stock">${p.stock}개 남음</span></article>`).join('');
const descriptions={pickupDays:'공휴일·주말 제외 · month=2026-12 · 목업 표본 · 실제 조회 시 Redis 하루 캐시',products:'상품과 현재 재고 조회 · Redis 30초 캐시 · X-Cache: HIT 또는 MISS',orders:'Idempotency-Key 헤더 필수 · { items: [{ productId: 1, quantity: 2 }] } · SQL 트랜잭션으로 접수',status:'received → preparing → ready → collected · { status: "preparing" } · 단계 건너뛰기 409',history:'MongoDB order_events 조회 · PostgreSQL outbox에서 재시도하여 기록',health:'PostgreSQL · MongoDB · Redis 연결 점검 · 장애 시 503'};
let json='';
function showEndpoint(name){json=JSON.stringify(data.responses[name],null,2);el('api-response').textContent=json;el('endpoint-description').textContent=descriptions[name];el('code-label').textContent=`RESPONSE · ${name==='orders'?'201 CREATED':'200 OK'}`;}
document.querySelectorAll('[data-endpoint]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-endpoint]').forEach(x=>x.classList.toggle('active',b===x));showEndpoint(b.dataset.endpoint);}));
el('copy-code').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(json);announce('JSON 응답을 복사했습니다.');}catch{announce('브라우저에서 복사를 허용해 주세요.');}});

function renderPickupDays(){
  const month=el('pickup-month').value;
  const items=holidayFixtures[month].response.body.items.item;
  const count=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate();
  const days=Array.from({length:count},(_,index)=>{
    const date=`${month}-${String(index+1).padStart(2,'0')}`;
    const holiday=items.find(item=>String(item.locdate)===date.replaceAll('-','')&&item.isHoliday==='Y');
    const weekend=[0,6].includes(new Date(date+'T00:00:00Z').getUTCDay());
    return {date,available:!holiday&&!weekend,reason:holiday?.dateName||(weekend?'주말':null)};
  });
  el('pickup-days').innerHTML=days.map(day=>`<span class="pickup-day ${day.available?'open':'closed'}" title="${day.date} · ${day.reason||'픽업 가능'}" aria-label="${day.date} ${day.available?'픽업 가능':day.reason+' 휴무'}">${Number(day.date.slice(8))}<small>${day.available?'가능':'휴무'}</small></span>`).join('');
  el('pickup-summary').textContent=`${month} · 픽업 가능 ${days.filter(day=>day.available).length}일 · 휴무일에 주문하면 다음 영업일을 안내합니다.`;
  data.responses.pickupDays={month,mode:'mock',days};
  if(document.querySelector('[data-endpoint="pickupDays"].active')) showEndpoint('pickupDays');
}
el('pickup-month').innerHTML=Object.keys(holidayFixtures).map(month=>`<option value="${month}">${month}</option>`).join('');
el('pickup-month').value='2026-12';
el('pickup-month').addEventListener('change',renderPickupDays);
renderPickupDays();

render();showEndpoint('products');
