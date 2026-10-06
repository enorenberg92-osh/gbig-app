import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(process.argv[2]||'artifacts/season-rehearsal.html','utf8');
const nodes=new Map();
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.value='';this.textContent='';}
  appendChild(child){this.children.push(child);if(this.tag==='select'&&!this.value)this.value=String(child.value);return child;}
  replaceChildren(){this.children=[];}
  addEventListener(event,fn){this.listeners[event]=fn;}
  querySelector(selector){const result=nodes.get(selector.slice(1));assert.ok(result,`Missing ${selector}`);return result;}
}
for(const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g))nodes.set(match[2],new Element(match[1]));
const context={document:{getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag)},window:{addEventListener(){},openai:{widgetState:null,setWidgetState:()=>Promise.resolve()}}};
vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1],context);
const row=(name,i)=>nodes.get(`season-${name}-body`).children[i].children.map(c=>c.textContent);
assert.deepEqual(row('total',0).slice(0,2),[1,'Team 060']);
assert.equal(nodes.get('season-total-page').textContent,'1–25 of 150');
for(let i=0;i<5;i++)nodes.get('season-total-next').listeners.click();
assert.equal(nodes.get('season-total-page').textContent,'126–150 of 150');
assert.equal(nodes.get('season-total-next').disabled,true);
nodes.get('season-week').value='3';nodes.get('season-week').listeners.change();
assert.match(nodes.get('season-status').textContent,/1 missed-round penalties/);
assert.equal(row('scores',0)[1],'Missed penalty');assert.equal(row('scores',0)[5],0);
nodes.get('season-week').value='6';nodes.get('season-week').listeners.change();
assert.equal(row('scores',4)[1],'Substitute played');
assert.match(nodes.get('season-skins-caption').textContent,/72 awarded, 36 tied/);
assert.equal(nodes.get('season-skins-body').children.length,9);
for(let i=0;i<11;i++)nodes.get('season-scores-next').listeners.click();
assert.equal(nodes.get('season-scores-page').textContent,'276–300 of 300');
assert.equal(nodes.get('season-scores-next').disabled,true);
assert.equal(row('scores',24)[0],'Golfer 300 / Team 150');
assert.ok(Buffer.byteLength(html)<1_000_000);
console.log(`PASS season report interactions, all 150 teams/300 cards reachable, penalties/substitutes/skins, ${Buffer.byteLength(html)} bytes`);
