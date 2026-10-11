// ---------- the page: loop, controls, target dragging, diagnostics ----------
let playing=true,demo=true,last=0,simT=3,acc=0,demoT=0,hitT=0;const RMq=matchMedia('(prefers-reduced-motion: reduce)').matches;if(RMq)playing=false;
const $=id=>document.getElementById(id);const st=$('st');
function sync(){$('bP').textContent=playing?'Pause':'Play';$('bP').setAttribute('aria-pressed',String(!playing));$('bA').setAttribute('aria-pressed',String(demo));$('bD').setAttribute('aria-pressed',String(debug));
  st.textContent=broken?'it came apart':'loop integrity '+Math.round(hp)+'% · '+hits+' hits · '+chunks.length+' pieces torn off';}
for(const[id,n] of[['mSlam','slam'],['mPunch','punch'],['mCross','cross'],['mUpper','upper']])$(id).onclick=()=>begin(n);
$('mAuto').onclick=()=>begin(pickMove());
$('bHit').onclick=()=>{for(let k=0;k<200;k++){const x=(Math.random()*W)|0,y=(Math.random()*H)|0;const o=OWN[y*W+x];if(o>=0&&o<300){hitAt(x,y,2.4);break;}}sync();};
$('bBreak').onclick=()=>{breakApart();sync();};$('bR').onclick=()=>{restore();sync();};$('bA').onclick=()=>{demo=!demo;sync();};$('bP').onclick=()=>{playing=!playing;sync();};$('bD').onclick=()=>{debug=!debug;sync();};
for(const k of Object.keys(TUNE)){const el=$('t_'+k);if(!el)continue;const o=$('o_'+k);el.addEventListener('input',()=>{TUNE[k]=el.value/100;o.textContent=(el.value/100).toFixed(2);});}
// drag the opponent anywhere; a click elsewhere hits 우리 there
const cM=$('cvM');let drag=false,downPos=null;
const toCanvas=e=>{const r=cM.getBoundingClientRect();return[(e.clientX-r.left)/r.width*W,(e.clientY-r.top)/r.height*H];};
cM.addEventListener('pointerdown',e=>{const p=toCanvas(e);downPos=p;if(Math.hypot(p[0]-target[0],p[1]-target[1])<22){drag=true;cM.setPointerCapture(e.pointerId);}});
cM.addEventListener('pointermove',e=>{if(!drag)return;const p=toCanvas(e);target=[Math.max(10,Math.min(W-10,p[0])),Math.max(10,Math.min(H-10,p[1]))];if(!playing)render(0);});
cM.addEventListener('pointerup',e=>{const p=toCanvas(e);if(drag){drag=false;return;}if(downPos&&Math.hypot(p[0]-downPos[0],p[1]-downPos[1])<4){if(hitAt(p[0],p[1],1.6)){sync();if(!playing)render(0);}}});
// keyboard: arrows move the opponent, keys trigger moves
document.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return;const m={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]}[e.key];if(m&&document.activeElement===cM){target=[Math.max(10,Math.min(W-10,target[0]+m[0])),Math.max(10,Math.min(H-10,target[1]+m[1]))];e.preventDefault();}});
function restore(){build();prepParts();buildCores();chunks=[];dust=[];rings=[];flashes=[];hp=100;hits=0;broken=false;slowmo=1;cur=null;resetLinks();MOONP.init=false;}
const gM=cM.getContext('2d');
function render(dt){frame(simT,dt);compose(gM,simT);overlay(gM);}
function overlay(g){// the opponent, and the diagnostics
  g.save();g.globalAlpha=.8;g.strokeStyle='#d9a15a';g.lineWidth=1;const[tx,ty]=target;g.beginPath();g.arc(tx,ty,10,0,TAU);g.stroke();g.beginPath();g.moveTo(tx-16,ty);g.lineTo(tx-6,ty);g.moveTo(tx+6,ty);g.lineTo(tx+16,ty);g.moveTo(tx,ty-16);g.lineTo(tx,ty-6);g.moveTo(tx,ty+6);g.lineTo(tx,ty+16);g.stroke();g.restore();
  if(!debug||!frame.T)return;const T=frame.T,O=frame.O;g.save();g.font='9px monospace';g.lineWidth=1;
  // centre of mass, barycentre, target vector, attack cone
  let mx=0,my=0,ms=0;const MW={chamber:6,domeL:4,domeR:4,fistL:3,fistR:3,uaL:1.5,uaR:1.5,faL:1.2,faR:1.2,pelvis:2,pyL:1.5,pyR:1.5,moon:.3};for(const n in MW){if(PARTS[n].gone)continue;mx+=T[n].piv[0]*MW[n];my+=T[n].piv[1]*MW[n];ms+=MW[n];}mx=mx/ms+O[0];my=my/ms+O[1];
  const bc=[(T._cores[0][0]+T._cores[1][0])/2+O[0],(T._cores[0][1]+T._cores[1][1])/2+O[1]];
  g.strokeStyle='#ffd27a';g.beginPath();g.moveTo(mx,my);g.lineTo(target[0],target[1]);g.stroke();g.fillStyle='#ffd27a';g.fillRect(mx-2,my-2,5,5);g.fillStyle='#c8a0ff';g.fillRect(bc[0]-2,bc[1]-2,5,5);
  const tv=targetVec();const ang=Math.atan2(target[1]-my,target[0]-mx);g.strokeStyle='rgba(255,210,122,.35)';g.beginPath();g.moveTo(mx,my);g.arc(mx,my,70,ang-36*D,ang+36*D);g.closePath();g.stroke();
  // pylon thrust vectors
  for(const s of['L','R']){const P=PARTS['py'+s];if(P.gone)continue;const p=T['py'+s];const x=p.piv[0]+O[0],y=p.piv[1]+O[1]+40;const a=Math.PI/2+p.ang+PYL[s].ang;g.strokeStyle='#9ff3ff';g.beginPath();g.moveTo(x,y);g.lineTo(x+Math.cos(a)*PYL[s].th*30,y+Math.sin(a)*PYL[s].th*30);g.stroke();}
  // readouts
  const rows=[['root ω',L.ha.v],['torso ω',L.ta.v],['shoulder L ω',L.sL.v],['shoulder R ω',L.sR.v],['torque',TORQ/100],['loop stress',STRESS],['fist L spread',L.cL.x],['fist R spread',L.cR.x]];
  g.fillStyle='rgba(5,6,12,.75)';g.fillRect(4,4,124,rows.length*11+60);g.fillStyle='#ece4d0';rows.forEach((r,i)=>g.fillText(r[0].padEnd(13)+r[1].toFixed(2),8,14+i*11));
  // connection integrity
  const IC=[['shoulder L',PARTS.uaL],['elbow L',PARTS.faL],['wrist L',PARTS.fistL],['shoulder R',PARTS.uaR],['elbow R',PARTS.faR],['wrist R',PARTS.fistR]];IC.forEach((c,i)=>{const v=c[1].gone?0:neckInt(c[1]);const y=14+rows.length*11+i*8;g.fillStyle='#24263a';g.fillRect(70,y-5,54,5);g.fillStyle=v>.6?'#9ff3ff':v>.35?'#ffd27a':'#ff6a3a';g.fillRect(70,y-5,54*v,5);g.fillStyle='#9d9483';g.fillText(c[0],8,y);});
  g.restore();}
const seq=['slam','punch','cross','upper','slam'];let seqI=0;const spots=[[118,150],[540,130],[150,60],[500,300],[330,330]];let spotI=0;
function loop(now){requestAnimationFrame(loop);let dt=Math.min(.05,last?(now-last)/1000:0);last=now;if(!playing)return;
  if(hitstop>0){hitstop-=dt;stepFx(dt*.2);acc+=dt;if(acc>=1/30){acc=0;frame(simT,0);compose(gM,simT);overlay(gM);}return;}
  dt*=slowmo;simT+=dt;stepFx(dt);
  if(demo){demoT+=dt;hitT+=dt;if(!broken&&!cur&&demoT>.7){if(seqI%2===0){target=spots[spotI++%spots.length].slice();}begin(seqI%3===2?pickMove():seq[seqI%seq.length]);seqI++;demoT=0;sync();}
    if(!broken&&hitT>1.6){hitT=0;for(let k=0;k<200;k++){const x=(Math.random()*W)|0,y=(Math.random()*H)|0;const o=OWN[y*W+x];if(o>=0&&o<300){hitAt(x,y,Math.random()<.25?2.2:1.1);break;}}sync();}
    if(broken&&simT-brokenT>9){restore();sync();}}
  // physics at a steady rate, drawing at ~30 fps
  let rem=dt;while(rem>0){const h=Math.min(1/120,rem);physicsOnly(h);rem-=h;}acc+=dt;if(acc<1/30)return;acc=0;frame(simT,0);compose(gM,simT);overlay(gM);}
function physicsOnly(h){tNow=simT;physics(simT,h);// keep fist velocities current for the reaction terms
  const TB=bodyTransforms();for(const s of['L','R']){const ua=PARTS['ua'+s],fa=PARTS['fa'+s],fi=PARTS['fist'+s];const Tsh=cmp(TB.Td[s],about(ua.joints.a,L['s'+s].x));const Tel=cmp(Tsh,about(ua.joints.b,L['e'+s].x));const Twr=cmp(Tel,about(fa.joints.b,L['w'+s].x));const p=ap(Twr,fi.pg);if(prevFist[s])fistVel[s]=[(p[0]-prevFist[s][0])/h,(p[1]-prevFist[s][1])/h];prevFist[s]=p;}}
window.__K={set playing(v){playing=v;},get cur(){return cur;},get hs(){return hitstop;},begin,step:dt=>{if(hitstop>0){hitstop-=dt;stepFx(dt*.2);frame(simT,0);compose(gM,simT);overlay(gM);return;}simT+=dt;stepFx(dt);let rem=dt;while(rem>0){const h=Math.min(1/120,rem);physicsOnly(h);rem-=h;}frame(simT,0);compose(gM,simT);overlay(gM);},set target(v){target=v;},set demo(v){demo=v;},set debug(v){debug=v;},hitAt,breakApart,restore,get L(){return L;}};
prepParts();for(let k=0;k<3;k++)render(.016);sync();requestAnimationFrame(loop);
}
</script></body></html>
