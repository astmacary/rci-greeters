const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
function setup(){
  const c = vm.createContext({});
  const helpers = html.slice(html.indexOf('const pad ='), html.indexOf('const ICON ='));
  const block = html.slice(html.indexOf('const GREETER_POSITIONS ='), html.indexOf('function adminFixedPositions'));
  vm.runInContext(helpers + `
    const CONFIG={profileCategory:'Roster'}; const DEMO=true;
    const S={items:[],busy:new Set()}; const isEditor=()=>true; const directoryVisible=p=> ![p.email,p.pendingEmail].includes("ashley.stmacary@therampchurch.com") && String(p.fullName||"").toLowerCase().replace(/\./g,"") !== "ashley st macary"; const toast=()=>{};
    const isProfile=i=>i.category==='Roster'; const isNonActive=p=>lc(p.active)==='non active';
    const isNoService=i=>i.category==='No Service'; const approved=i=>lc(i.status)==='accepted';
    const rosterPeople=()=>S.items.filter(isProfile);
    const templateCategory=rows=>rows.find(i=>!isNoService(i))?.category||'';
    const templateCallTime=()=>'';
    const normalize=(id,f)=>({id,fullName:f.SecurityName,role:f.Placement,status:f.Status,email:f.email,personId:f.NameLookupId,category:f.ServiceCategory});
    const writes=[]; const API={update:async(id,fields)=>{writes.push({id,...fields});},addRow:async(k,cat,extra)=>{writes.push({k,cat,...extra});return String(100+writes.length)}};
    ` + block + `
    globalThis.state=S;globalThis.writes=writes;
    globalThis.plan=sundayPreloadPlan;globalThis.assign=assignGreeter;globalThis.unavailable=greeterUnavailable;
    globalThis.sync=syncSundayConfirmations; globalThis.previous=precedingSunday;globalThis.openings=fixedOpenings;
    `,c);
  return c;
}
const person=(id,extra={})=>({id,personId:id,fullName:'Person '+id,email:id+'@example.org',category:'Roster',editable:true,...extra});
const row=(id,date,role,status='Accepted')=>({...person(id),id:'row-'+id,date,role,status,category:date.endsWith('01')?'Sunday Morning':'Wednesday Night'});
test('Wednesday uses the preceding Sunday across month and year boundaries',()=>{
  const c=setup();
  assert.equal(c.previous('2026-04-01'),'2026-03-29');
  assert.equal(c.previous('2025-01-01'),'2024-12-29');
  assert.equal(c.previous('2026-11-18'),'2026-11-15');
});
test('preload preserves existing slots, skips absent/inactive/declined people and deduplicates Sunday services',()=>{
  const c=setup(), k='2026-04-01';
  c.state.items=[person('a'),person('b',{timeOff:k}),person('c',{active:'Non Active'}),person('d'),person('e'),person('f'),
    row('a','2026-03-29','Guest Cards'),row('a','2026-03-29','Guest Cards'),row('b','2026-03-29','Front door'),
    row('c','2026-03-29','Lobby greeter'),row('d','2026-03-29','Lobby greeter','Declined'),
    row('e','2026-03-29','Front door'),row('f',k,'Front door')];
  const plan=c.plan(k);
  assert.equal(plan.assignments.length,1);
  assert.equal(plan.conflicts.length,1);
  assert.equal(plan.assignments.find(x=>x.p.personId==='a').role,'Guest Cards');
  assert.equal(plan.assignments.some(x=>x.role==='Front door'),false);
  assert.equal(new Set(plan.assignments.map(x=>x.p.personId)).size,1);
});
test('new requests stay Pending and repeating a successful preload adds no duplicates',async()=>{
  const c=setup(),k='2026-04-01';
  c.state.items=[person('a'),person('b'),row('a','2026-03-29','Lobby greeter'),row('b','2026-03-29','Lobby greeter')];
  for(const x of c.plan(k).assignments) await c.assign(k,x.role,x.p);
  assert.equal(c.writes.length,2);
  assert.equal(c.writes[0].Status,'Pending');
  assert.equal(c.writes[0].cat,'Wednesday Night');
  assert.equal(c.plan(k).assignments.every(x=>!!x.existing),true);
  assert.equal(c.openings(c.state.items.filter(x=>x.date===k)).length,4);
});
test('available replacements can fill declined slots but duplicate assignments and No Service writes are blocked',async()=>{
  const c=setup(),k='2026-04-01',p=person('b');
  c.state.items=[person('a'),p,row('a',k,'Front door','Declined')];
  await c.assign(k,'Front door',p);
  await assert.rejects(c.assign(k,'Lobby greeter',p),/already has a row/);
  c.state.items.push({date:k,category:'No Service'});
  await assert.rejects(c.assign(k,'Guest Cards',person('z')),/No Service/);
});
test('ISO and legacy multiple-day absences are respected after reload',()=>{
  const c=setup(),k='2026-04-01';
  assert.equal(c.unavailable(person('a',{notes:'<p data-absence-dates="2026-03-31,2026-04-01"><strong>Dates of Absence:</strong> Tue, Mar 31; Wed, Apr 1</p>'}),k),true);
  assert.equal(c.unavailable(person('a',{notes:'<p><strong>Dates of Absence:</strong> '+new Date(2026,3,1).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})+'</p>'}),k),true);
});

test('automatic carryover keeps duplicate position slots, exact positions and confirmations', async()=>{
  const c=setup(), k='2026-04-01';
  c.state.items=[person('a'),person('b'),person('c'),row('a','2026-03-29','Lobby greeter'),row('b','2026-03-29','Lobby greeter'),row('c','2026-03-29','Guest Cards')];
  await c.sync(k);
  const target=c.state.items.filter(x=>x.date===k);
  assert.equal(target.length,3);
  assert.equal(target.filter(x=>x.role==='Lobby greeter').length,2);
  assert.equal(target.every(x=>x.status==='Accepted'),true);
  assert.equal(target.find(x=>x.personId==='c').role,'Guest Cards');
  await c.sync(k);
  assert.equal(c.writes.length,3);
});
test('automatic carryover skips absences, No Service and Ashley, and confirms an existing pending assignment',async()=>{
  const c=setup(), k='2026-04-01';
  c.state.items=[person('a'),person('b',{timeOff:k}),person('x',{fullName:'Ashley St. Macary',email:'ashley.stmacary@therampchurch.com'}),row('a','2026-03-29','Guest Cards'),row('b','2026-03-29','Front door'),{...row('x','2026-03-29','Lobby greeter'),fullName:'Ashley St. Macary',email:'ashley.stmacary@therampchurch.com'},row('a',k,'Guest Cards','Pending')];
  await c.sync(k);
  assert.equal(c.state.items.find(x=>x.date===k).status,'Accepted');
  assert.equal(c.writes.length,1);
  const d=setup(); d.state.items=[person('a'),row('a','2026-03-29','Front door'),{date:k,category:'No Service'}];
  await d.sync(k);assert.equal(d.writes.length,0);
});

test('an absence reported after carryover removes the Wednesday confirmation',async()=>{
  const c=setup(), k='2026-04-01';
  const p=person('a');
  c.state.items=[p,row('a','2026-03-29','Front door')];
  await c.sync(k); p.timeOff=k;
  await c.sync(k);
  assert.equal(c.state.items.find(x=>x.date===k).status,'Declined');
  assert.equal(c.state.items.filter(x=>x.date===k).length,1);
});
