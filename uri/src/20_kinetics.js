
// ================= the kinetic system: intent in, momentum out =================
const D=Math.PI/180;
const rot=(p,c,a)=>{const s=Math.sin(a),co=Math.cos(a),x=p[0]-c[0],y=p[1]-c[1];return[c[0]+x*co-y*s,c[1]+x*s+y*co];};
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
// tuning, exposed on the page
const TUNE={stiff:1,damp:1,mass:1,react:1,thrust:1,loop:1,hitstop:1};
// ---------- extra structure per part: fist chunk centres (for compression), load-bearing necks ----------
function prepParts(){for(const n in PARTS){const P=PARTS[n];const N=P.nchunk;P.cc=new Float32Array(N*2);P.cb=new Int16Array(N*4).fill(-1);const cnt=new Uint16Array(N);
  for(let iy=0;iy<P.h;iy++)for(let ix=0;ix<P.w;ix++){const i=iy*P.w+ix;if(!P.mat[i])continue;const c=P.chunk[i];P.cc[c*2]+=ix;P.cc[c*2+1]+=iy;cnt[c]++;const b=c*4;if(P.cb[b]<0||ix<P.cb[b])P.cb[b]=ix;if(iy<P.cb[b+1]||P.cb[b+1]<0)P.cb[b+1]=iy;if(ix>P.cb[b+2])P.cb[b+2]=ix;if(iy>P.cb[b+3])P.cb[b+3]=iy;}
  for(let c=0;c<N;c++)if(cnt[c]){P.cc[c*2]/=cnt[c];P.cc[c*2+1]/=cnt[c];}}
  // the connections that carry the load: shoulder, elbow, wrist, pylon root
  const neck=(n,J,R)=>{const P=PARTS[n];const lx=J[0]-P.pg[0]+P.pivX,ly=J[1]-P.pg[1]+P.pivY;const idx=[];for(let iy=0;iy<P.h;iy++)for(let ix=0;ix<P.w;ix++){const i=iy*P.w+ix;if(P.mat[i]&&Math.hypot(ix-lx,iy-ly)<R)idx.push(i);}P.neck=idx;P.neckN=idx.length;};
  for(const s of['L','R']){neck('ua'+s,PARTS['ua'+s].joints.a,13);neck('fa'+s,PARTS['fa'+s].joints.a,13);neck('fist'+s,PARTS['fa'+s].joints.b,14);}
  neck('pyL',PARTS.pyL.joints.a,12);neck('pyR',PARTS.pyR.joints.a,12);}
const integrity=P=>P.gone?0:P.left/P.total;
const neckInt=P=>{if(!P.neck||!P.neckN)return 1;let a=0;for(const i of P.neck)if(P.mat[i]&&P.alive[P.chunk[i]])a++;return a/P.neckN;};
// ---------- links: every degree of freedom has mass, stiffness, damping, a velocity and a limit ----------
// mass classes: very high (root, torso, arks, fists) · high (upper arms, pylons) · medium (forearms) · low (command moon)
const LINK_DEF={hx:4.6,hy:4.6,ha:4.6,ta:4.0,daL:3.4,daR:3.4,dxL:3.4,dxR:3.4,sL:2.3,sR:2.3,eL:1.5,eR:1.5,wL:2.8,wR:2.8,cL:1.0,cR:1.0};
const LIM={ha:[-8*D,8*D],ta:[-18*D,18*D],daL:[-30*D,30*D],daR:[-30*D,30*D],dxL:[-22,22],dxR:[-22,22],hx:[-40,40],hy:[-40,40],sL:[-340*D,340*D],sR:[-340*D,340*D],eL:[-160*D,160*D],eR:[-160*D,160*D],wL:[-60*D,60*D],wR:[-60*D,60*D],cL:[.8,1.3],cR:[.8,1.3]};
let L={};function resetLinks(){L={};for(const k in LINK_DEF)L[k]={x:k[0]==='c'?1.1:0,v:0,tgt:k[0]==='c'?1.1:0,km:1,zeta:.5,ext:0,m:LINK_DEF[k]};}resetLinks();
function stepLinks(dt,dmgMod){for(const k in L){const l=L[k];const m=l.m*TUNE.mass;const kk=58*TUNE.stiff*l.km*(dmgMod[k]?dmgMod[k].k:1);const c=2*l.zeta*Math.sqrt(kk*m)*TUNE.damp*(dmgMod[k]?dmgMod[k].c:1);
  let a=(kk*(l.tgt-l.x)-c*l.v+l.ext)/m;const amax=(k[0]==='h'&&k!=='ha'?2600:k[0]==='d'&&k.startsWith('dx')?2200:k[0]==='c'?40:58*Math.sqrt(l.km))/m;a=Math.max(-amax,Math.min(amax,a));l.v+=a*dt;l.x+=l.v*dt;const lm=LIM[k];if(lm){if(l.x<lm[0]){l.x=lm[0];l.v*=-.2;}if(l.x>lm[1]){l.x=lm[1];l.v*=-.2;}}l.ext=0;}}
// ---------- 2D transforms ----------
const ap=(T,p)=>{const c=Math.cos(T.a),s_=Math.sin(T.a);return[p[0]*c-p[1]*s_+T.x,p[0]*s_+p[1]*c+T.y];};
const about=(c,a)=>{const co=Math.cos(a),si=Math.sin(a);return{a,x:c[0]-(c[0]*co-c[1]*si),y:c[1]-(c[0]*si+c[1]*co)};};
const cmp=(A,B)=>{const p=ap(A,[B.x,B.y]);return{a:A.a+B.a,x:p[0],y:p[1]};};
const tr=(dx,dy)=>({a:0,x:dx,y:dy});
function bodyTransforms(){const PE=PARTS.pelvis,CHM=PARTS.chamber;const hipC=PE.pg,torsoC=[CHM.pg[0],PE.pg[1]-14];
  const Thip=cmp(tr(L.hx.x,L.hy.x),about(hipC,L.ha.x));const Ttor=cmp(Thip,about(torsoC,L.ta.x));const Td={};
  for(const s of['L','R']){const dm=PARTS['dome'+s];const inner=[dm.pg[0]+(s==='L'?1:-1)*30,dm.pg[1]+22];Td[s]=cmp(Ttor,cmp(tr(L['dx'+s].x,0),about(inner,L['da'+s].x)));}
  return{Thip,Ttor,Td};}
// ---------- constrained IK: where should shoulder and elbow be for the wrist to reach this point? ----------
function solveArm(s,Wd,Td,limitReach=.97){const ua=PARTS['ua'+s],fa=PARTS['fa'+s];const S0=ua.joints.a,E0=ua.joints.b,W0=fa.joints.b;
  const L1=Math.hypot(E0[0]-S0[0],E0[1]-S0[1]),L2=Math.hypot(W0[0]-E0[0],W0[1]-E0[1]);const a10=Math.atan2(E0[1]-S0[1],E0[0]-S0[0]),a20=Math.atan2(W0[1]-E0[1],W0[0]-E0[0]);
  const S=ap(Td,S0);let dx=Wd[0]-S[0],dy=Wd[1]-S[1];let d=Math.hypot(dx,dy)||1;const dmax=(L1+L2)*limitReach,dmin=Math.abs(L1-L2)+4;const dc=Math.max(dmin,Math.min(dmax,d));const ph=Math.atan2(dy,dx);
  const cb=Math.max(-1,Math.min(1,(L1*L1+dc*dc-L2*L2)/(2*L1*dc)));const be=Math.acos(cb);
  // of the two solutions keep the one whose elbow swings outward, away from the body — how these arms are built
  let best=null;for(const sg of[1,-1]){const t1=ph+sg*be;const E=[S[0]+Math.cos(t1)*L1,S[1]+Math.sin(t1)*L1];const t2=Math.atan2(S[1]+Math.sin(ph)*dc-E[1],S[0]+Math.cos(ph)*dc-E[0]);
    const out=(s==='L'?-1:1)*(E[0]-200)+.3*(E[1]-S[1]);if(!best||out>best.out)best={t1,t2,out,E};}
  return{s:wrap(best.t1-a10-Td.a),e:wrap((best.t2-best.t1)-(a20-a10)),S,reach:d/(L1+L2)};}
// ---------- the opponent: a target vector from the centre of mass ----------
let target=[118,150];// screen coordinates
const CM0=[CX,CY-12];
function targetVec(){const dx=target[0]-CM0[0],dy=target[1]-CM0[1];return{x:dx,y:dy,dist:Math.hypot(dx,dy),ang:Math.atan2(-dy,dx)};}
// ---------- moves as intent: phases with goals; the chain decides how to arrive ----------
// in every phase: goals for root/torso/domes, wrist goals for the arms that act, fist compression, how stiff each region is
const MOVE={
 punch:{phases:[{n:'load',d:.3},{n:'drive',d:.2,hit:true},{n:'follow',d:.18},{n:'taper',d:1.5}]},
 cross:{phases:[{n:'coil',d:.38},{n:'release',d:.26,hit:true},{n:'follow',d:.22},{n:'taper',d:1.7}]},
 slam:{phases:[{n:'load',d:.2},{n:'rise',d:.5},{n:'apex',d:.26},{n:'fall',d:.2,hit:true},{n:'follow',d:.28},{n:'taper',d:2.3}]},
 upper:{phases:[{n:'compress',d:.3},{n:'launch',d:.22,hit:true},{n:'follow',d:.22},{n:'taper',d:1.5}]}};
// the authored gesture: arm angles per phase, written for the right arm leading (mirrored for the left). the solver only corrects it.
const AUTH={
 punch:{load:{lead:[22,30,8],rear:[-8,-6,0]},drive:{lead:[-50,-60,-10],rear:[10,8,0]},follow:{lead:[-55,-63,-12],rear:[10,8,0]}},
 cross:{coil:{lead:[-6,-4,0],rear:[42,34,0]},release:{lead:[8,6,0],rear:[-100,36,-10]},follow:{lead:[10,6,0],rear:[-106,40,-12]}},
 slam:{load:{lead:[-8,-6,0],rear:[8,6,0]},rise:{lead:[-112,-102,-18],rear:[112,102,18]},apex:{lead:[-122,-112,-20],rear:[122,112,20]},fall:{lead:[30,18,0],rear:[-30,-18,0]},follow:{lead:[33,20,0],rear:[-33,-20,0]}},
 upper:{compress:{lead:[26,44,10],rear:[0,0,0]},launch:{lead:[-150,-20,-10],rear:[10,6,0]},follow:{lead:[-155,-24,-12],rear:[10,6,0]}}};
let cur=null;
function pickMove(){const tv=targetVec();const el=Math.atan2(-tv.y,Math.abs(tv.x))/D;if(el>40)return'upper';if(el<-38)return'slam';return(cur&&cur.last==='punch')?'cross':'punch';}
function begin(name){if(broken)return;const tv=targetVec();const dir=tv.x>=0?1:-1;
  // the arm on the opponent's side leads; the other is the rear arm. no mirroring: the body's real sides
  const lead=dir>0?'R':'L',rear=dir>0?'L':'R';cur={name,t0:tNow,dir,lead,rear,ph:0,phT:tNow,hitDone:false,last:name};}
function goals(t,T){const G={hx:0,hy:0,ha:0,ta:0,daL:0,daR:0,dxL:0,dxR:0,cL:1.14,cR:1.14,wrist:{},auth:{},ikw:.15,km:{},zeta:{},phase:null};if(!cur)return G;
  const M=MOVE[cur.name];let ph=M.phases[cur.ph];let u=(t-cur.phT)/ph.d;
  // a striking phase ends when the fist has actually arrived (or the body gives up waiting), not when a clock says so
  while(u>=1){if(ph.hit&&!cur.hitDone){if(!((cur.arrive!==undefined&&cur.arrive<22)||u>=3.2))break;cur.hitDone=true;cur.impact=true;}cur.ph++;cur.phT=t;if(cur.ph>=M.phases.length){cur=null;return G;}ph=M.phases[cur.ph];u=0;}
  const d=cur.dir,ld=cur.lead,rr=cur.rear;const n=ph.n;G.phase=n;const m=d;
  const A=(AUTH[cur.name]||{})[n];if(A){G.auth[ld]=A.lead.map(v=>v*m*D);G.auth[rr]=A.rear.map(v=>v*m*D);}
  const Sw=s=>ap(T.Td[s],PARTS['ua'+s].joints.a);const armLen=s=>{const ua=PARTS['ua'+s],fa=PARTS['fa'+s];return Math.hypot(ua.joints.b[0]-ua.joints.a[0],ua.joints.b[1]-ua.joints.a[1])+Math.hypot(fa.joints.b[0]-fa.joints.a[0],fa.joints.b[1]-fa.joints.a[1]);};
  const reachDir=(S,cone,axis)=>{const tx=target[0]-CX+ORX,ty=target[1]-CY+ORY;let a=Math.atan2(ty-S[1],tx-S[0]);const da=wrap(a-axis);a=axis+Math.max(-cone,Math.min(cone,da));return[Math.cos(a),Math.sin(a)];};
  // aiming correction grows only for steep targets
  const tv=targetVec();const el=Math.abs(Math.atan2(-tv.y,Math.abs(tv.x)))/D;G.ikw=.14+.14*Math.min(1,Math.max(0,(el-20)/45));
  const taper=()=>{// layered settling: the fist resolves first, then the arm, then the shoulder ark, then the torso and root
    G.km={wL:1.1,wR:1.1,cL:.55,cR:.55,sL:.62,sR:.62,eL:.66,eR:.66,daL:.42,daR:.42,dxL:.42,dxR:.42,ta:.3,ha:.3,hx:.28,hy:.28};};
  if(cur.name==='punch'){const S=Sw(ld),Ln=armLen(ld);const rd=reachDir(S,30*D,d>0?0:Math.PI);
    if(n==='load'){Object.assign(G,{hx:-6*d,hy:2,ha:-2*D*d,ta:-5*D*d});G['da'+ld]=-7*D*d;G['dx'+ld]=-3*d;G['da'+rr]=3*D*d;G['c'+ld]=1.0;}
    if(n==='drive'||n==='follow'){Object.assign(G,{hx:(n==='drive'?11:12)*d,ha:3*D*d,ta:7*D*d});G['da'+ld]=12*D*d;G['dx'+ld]=8*d;G['da'+rr]=-4*D*d;G.wrist[ld]=[S[0]+rd[0]*Ln,S[1]+rd[1]*Ln];G['c'+ld]=.8;}
    if(n==='taper')taper();}
  if(cur.name==='cross'){const S=Sw(rr),Ln=armLen(rr);
    if(n==='coil'){Object.assign(G,{hx:-7*d,hy:1,ha:-3*D*d,ta:-10*D*d});G['da'+rr]=-11*D*d;G['dx'+rr]=-6*d;G['da'+ld]=4*D*d;G['c'+rr]=1.0;}
    if(n==='release'||n==='follow'){Object.assign(G,{hx:11*d,ha:4*D*d,ta:13*D*d});G['da'+rr]=15*D*d;G['dx'+rr]=12*d;G['da'+ld]=-6*D*d;G['dx'+ld]=-4*d;const tx=target[0]-CX+ORX,ty=target[1]-CY+ORY;const a=Math.atan2(ty-150,tx-200);G.wrist[rr]=[200+Math.cos(a)*Ln*.62,150+Math.sin(a)*Ln*.62+10];G['c'+rr]=.8;}
    if(n==='taper')taper();}
  if(cur.name==='slam'){// URI falls through its own attack
    if(n==='load'){Object.assign(G,{hy:6});G.cL=G.cR=1.06;}
    if(n==='rise'){Object.assign(G,{hy:-20});G.daL=-14*D;G.daR=14*D;G.dxL=-4;G.dxR=4;G.cL=G.cR=.98;G.km={sL:.75,sR:.75,eL:.7,eR:.7};}
    if(n==='apex'){// a held moment of impossible poise: still, not floppy
      Object.assign(G,{hy:-23+Math.sin(t*37)*.4});G.daL=-16*D;G.daR=16*D;G.cL=G.cR=.92;G.km={hy:1.1};}
    if(n==='fall'||n==='follow'){const tx=target[0]-CX+ORX;const below=Math.min(1,Math.max(-1,(tx-200)/180));Object.assign(G,{hy:n==='fall'?16:18,hx:below*7,ta:below*4*D});G.daL=7*D;G.daR=-7*D;G.dxL=3;G.dxR=-3;
      G.wrist.L=[200-26+below*30,262];G.wrist.R=[200+26+below*30,262];G.cL=G.cR=.78;if(n==='fall')G.km={hy:1.7,hx:1.3,sL:2.6,sR:2.6,eL:2.2,eR:2.2};}
    if(n==='taper'){taper();for(const k in G.km)G.km[k]*=.85;}}
  if(cur.name==='upper'){const S=Sw(ld),Ln=armLen(ld);const rd=reachDir(S,36*D,-Math.PI/2);
    if(n==='compress'){Object.assign(G,{hy:9,hx:-2*d,ta:-4*D*d});G['da'+ld]=6*D*d;G['dx'+ld]=-2*d;G['c'+ld]=.98;}
    if(n==='launch'||n==='follow'){Object.assign(G,{hy:n==='launch'?-14:-16,hx:4*d,ta:5*D*d});G['da'+ld]=-16*D*d;G['dx'+ld]=5*d;G['dx'+rr]=3*d;G['da'+rr]=4*D*d;G.wrist[ld]=[S[0]+rd[0]*Ln,S[1]+rd[1]*Ln];G['c'+ld]=.8;if(n==='launch')G.km={hy:1.4,['s'+ld]:1.2};}
    if(n==='taper')taper();}
  return G;}
// ---------- the reaction: momentum budget, counter-torque, pylons, the loop, the moon ----------
const MOONP={x:0,y:0,vx:0,vy:0,a:0,va:0,init:false};
const LOOP={l:{x:1,v:0},r:{x:1,v:0},sh:{x:0,v:0},vt:{x:1,v:0},br:{x:1,v:0}};const CORE={x:0,v:0,y:0,vy:0};const MOON={x:0,y:0,vx:0,vy:0,init:false};
const PYL={L:{th:.5,ang:0},R:{th:.5,ang:0}};let prevFist={L:null,R:null},fistVel={L:[0,0],R:[0,0]},TORQ=0,STRESS=0;
function springTo(o,tg,k,c,dt){o.v+=(k*(tg-o.x)-c*o.v)*dt;o.x+=o.v*dt;}
let impactInfo=null;
function physics(t,dt){if(dt<=0)return;const T=bodyTransforms();const G=goals(t,T);
  // goals → link targets; arms that act get theirs from the IK; arms that don't stay home
  for(const k of['hx','hy','ha','ta','daL','daR','dxL','dxR','cL','cR'])L[k].tgt=G[k];
  for(const s of['L','R']){let a=G.auth[s]||[0,0,0];let ts=a[0],te=a[1];
    if(G.wrist[s]){const r=solveArm(s,G.wrist[s],T.Td[s]);ts=a[0]+G.ikw*wrap(r.s-a[0]);te=a[1]+G.ikw*wrap(r.e-a[1]);}
    L['s'+s].tgt=L['s'+s].x+wrap(ts-L['s'+s].x);L['e'+s].tgt=L['e'+s].x+wrap(te-L['e'+s].x);L['w'+s].tgt=a[2];}
  // damping character by region: root and torso near-critical, arks slightly under, arms restrained, fists the most kinetic
  const Z={hx:.98,hy:.98,ha:.98,ta:.96,daL:.74,daR:.74,dxL:.78,dxR:.78,sL:.8,sR:.8,eL:.78,eR:.78,wL:.7,wR:.7,cL:.52,cR:.52};
  for(const k in L){L[k].km=G.km[k]||1;L[k].zeta=G.zeta[k]||Z[k];}
  // damage changes how the structure carries load: less stiffness and damping where it is broken
  const dm={};const ai={L:Math.min(integrity(PARTS.uaL),integrity(PARTS.faL)),R:Math.min(integrity(PARTS.uaR),integrity(PARTS.faR))};
  for(const s of['L','R']){const q=ai[s];dm['s'+s]=dm['e'+s]=dm['w'+s]={k:.7+.3*q,c:.55+.45*q};const dq=integrity(PARTS['dome'+s]);dm['da'+s]=dm['dx'+s]={k:1,c:.5+.5*dq};}
  const pyEff={L:PARTS.pyL.gone?0:integrity(PARTS.pyL),R:PARTS.pyR.gone?0:integrity(PARTS.pyR)};
  // counter-torque: the arms' angular momentum pushes the rest of the war-body the other way
  let Larm=0;const r1=60,r2=55,r3=30;for(const s of['L','R']){Larm+=L['s'+s].m*L['s'+s].v*r1+L['e'+s].m*L['e'+s].v*r2*.7+L['w'+s].m*L['w'+s].v*r3*.4;}
  TORQ=Larm;// counter-torque is mostly suppressed inside the structure; only a little of it is allowed to move the body
  L.ta.ext+=-Larm*.05*TUNE.react;L.ha.ext+=-Larm*.015*TUNE.react;CORE.v+=-Larm*.0009*TUNE.react*dt*60;
  const other_=Larm>0?'L':'R';L['da'+other_].ext+=-Larm*.012*TUNE.react;
  for(const s of['L','R']){const fv=fistVel[s];const other=s==='L'?'R':'L';L.hx.ext+=-fv[0]*.3*TUNE.react;L['dx'+other].ext+=-fv[0]*.1*TUNE.react;L.hy.ext+=-fv[1]*.12*TUNE.react;}
  // the pylons solve what is left: they damp drift and spin, as far as each one still can
  const corrX=-(L.hx.v*.04+L.ta.v*1.6),corrY=-(L.hy.v*.05);const comp=TUNE.thrust;
  L.ta.ext+=-L.ta.v*6*comp*(pyEff.L+pyEff.R)*.5;L.hx.ext+=-L.hx.v*2.2*comp*(pyEff.L+pyEff.R)*.5;L.hy.ext+=-L.hy.v*2*comp*(pyEff.L+pyEff.R)*.5;
  for(const s of['L','R']){const side=s==='L'?-1:1;const p=PYL[s];const ph_=cur&&MOVE[cur.name].phases[cur.ph]?MOVE[cur.name].phases[cur.ph].n:null;const commit=['drive','release','launch','fall','follow'].includes(ph_)?.55:['load','coil','compress'].includes(ph_)?.3:ph_==='taper'?.25:0;
    const want=.45+commit+Math.min(1.2,Math.abs(Larm)*.004)*(Larm*side<0?1.3:.7)+Math.max(0,corrY*.9)+Math.max(0,corrX*side*1.1)+Math.abs(L.ta.v)*.4+(cur&&cur.name==='slam'&&MOVE.slam.phases[cur.ph]&&['rise','apex'].includes(MOVE.slam.phases[cur.ph].n)?1.2:0)+(cur&&cur.name==='upper'&&MOVE.upper.phases[cur.ph]&&MOVE.upper.phases[cur.ph].n==='launch'?1.1:0);
    p.th+=(want*pyEff[s]*TUNE.thrust-p.th)*Math.min(1,dt*5);p.ang+=((-corrX*side*.25)-p.ang)*Math.min(1,dt*6);}
  stepLinks(dt,dm);
  // how far are the striking arms from their (authored + corrected) pose? the blow lands when they get there
  if(cur){let worst=0,any=false;for(const s_ of['L','R']){if(!G.wrist[s_])continue;any=true;worst=Math.max(worst,(Math.abs(L['s'+s_].tgt-L['s'+s_].x)+Math.abs(L['e'+s_].tgt-L['e'+s_].x)*.8)*60);}cur.arrive=any?worst:0;}
  // the loop is the inertial nervous system: lobes stretch on the side carrying load, the crossing shears with the spin
  const loadR=Math.max(0,Larm)*.004,loadL=Math.max(0,-Larm)*.004;const dmgLoop=1-integrity(PARTS.chamber)*.7-(hp/100)*.3+.3;
  const phn=cur&&MOVE[cur.name].phases[cur.ph]?MOVE[cur.name].phases[cur.ph].n:null;const slamRise=cur&&cur.name==='slam'&&['rise','apex'].includes(phn);const loading=['load','coil','compress'].includes(phn);const tapering=phn==='taper'||!cur;const lk=tapering?20:40,lc=tapering?3.2:6;
  springTo(LOOP.r,slamRise?.82:loading?.93:1+Math.min(.3,loadR)-Math.min(.14,loadL*.5),lk,lc*(1/dmgLoop),dt);springTo(LOOP.l,slamRise?.82:loading?.93:1+Math.min(.3,loadL)-Math.min(.14,loadR*.5),lk,lc*(1/dmgLoop),dt);
  springTo(LOOP.sh,Math.max(-12,Math.min(12,L.ta.v*7+Larm*.012)),tapering?18:30,tapering?2.6:4,dt);springTo(LOOP.vt,1+Math.max(-.25,Math.min(.35,-L.hy.v*.014)),tapering?18:30,tapering?2.6:4,dt);springTo(LOOP.br,1+Math.min(.6,Math.abs(Larm)*.003),20,6,dt);
  STRESS=Math.min(1,Math.abs(LOOP.l.x-1)+Math.abs(LOOP.r.x-1)+Math.abs(LOOP.sh.x)/20+Math.abs(LOOP.vt.x-1));
  // the command moon: pulled along by the body's gravity, not carried. heavy, so it lags and swings a little, then settles
  {const anc=ap(T.Ttor,PARTS.moon.pg);if(!MOONP.init){MOONP.x=anc[0];MOONP.y=anc[1];MOONP.init=true;}const dx=anc[0]-MOONP.x,dy=anc[1]-MOONP.y;const dist=Math.hypot(dx,dy);
    const pull=34*(1+Math.min(1.5,dist/14));// the further it trails, the harder the pull: a tether, not a spring toy
    MOONP.vx+=(pull*dx-2*.82*Math.sqrt(34)*MOONP.vx)*dt;MOONP.vy+=(pull*dy-2*.82*Math.sqrt(34)*MOONP.vy)*dt;MOONP.x+=MOONP.vx*dt;MOONP.y+=MOONP.vy*dt;
    const ex=MOONP.x-anc[0],ey=MOONP.y-anc[1],ed=Math.hypot(ex,ey);if(ed>12){MOONP.x=anc[0]+ex/ed*12;MOONP.y=anc[1]+ey/ed*12;}
    // it keeps facing the way the body faces, a beat late — a head, not a ball
    MOONP.va+=(30*(T.Ttor.a*.8+MOONP.vx*.004-MOONP.a)-2*.9*Math.sqrt(30)*MOONP.va)*dt;MOONP.a+=MOONP.va*dt;}
  // the cores shake in their cradles but never leave them
  CORE.v+=(-90*CORE.x-4*CORE.v)*dt;CORE.x+=CORE.v*dt;CORE.vy+=(-90*CORE.y-4*CORE.vy)*dt;CORE.y+=CORE.vy*dt;
  // impact
  if(cur&&cur.impact){cur.impact=false;const nm=cur.name;
    // the blow stops on contact: striking arms lose their speed into the target; fists hit maximum compression
    const acting=nm==='slam'?['L','R']:nm==='cross'?[cur.rear]:[cur.lead];for(const a of acting){for(const j of['s','e','w'])L[j+a].v*=.12;L['c'+a].x=Math.min(L['c'+a].x,.74);L['c'+a].v=0;}
    const hs={punch:.12,cross:.14,slam:.24,upper:.12}[nm]*TUNE.hitstop;hitstop=hs;shake=nm==='slam'?10:5;
    const d=cur.dir;
    if(nm==='punch'){L.hx.v-=d*16;LOOP[d>0?'r':'l'].v+=2.2;LOOP.sh.v+=d*14;CORE.v+=d*22;}
    if(nm==='cross'){L.ta.v+=d*.35;LOOP.sh.v+=d*30;CORE.v+=d*28;}
    if(nm==='slam'){L.hy.v-=28;LOOP.l.v+=3.4;LOOP.r.v+=3.4;LOOP.br.v+=4;CORE.vy+=70;CORE.v+=(Math.random()-.5)*26;}
    if(nm==='upper'){L.hy.v-=14;LOOP.vt.v+=3;CORE.vy-=40;}
    LOOP.br.v+=2.5;
    impactInfo={nm,d,lead:cur.lead,rear:cur.rear};}}
// ---------- one frame: physics, then draw ----------
let tNow=0,still=false;let hitstop=0,shake=0,slowmo=1,flashes=[],rings=[],dust=[],chunks=[],hp=100,hits=0,broken=false,brokenT=0;let debug=false;
function frame(t,dt){tNow=t;clr();CSPIN+=dt*.25;const dmg=1-hp/100;
  if(!still)physics(t,dt);
  const idle=still?0:1;const cx=CX+Math.sin(t*.37)*1.2*idle+(Math.random()-.5)*shake,cy=CY+Math.sin(t*.53)*1.6*idle+(Math.random()-.5)*shake;const OX_=cx-ORX,OY_=cy-ORY;
  const TB=still?{Thip:tr(0,0),Ttor:tr(0,0),Td:{L:tr(0,0),R:tr(0,0)}}:bodyTransforms();const T={};const place=(n,Tx)=>{const P=PARTS[n];T[n]={piv:ap(Tx,P.pg),ang:Tx.a};};
  place('pelvis',TB.Thip);for(const n of['pyL','pyR']){const P=PARTS[n];const s=n==='pyL'?'L':'R';T[n]={piv:ap(TB.Thip,P.pg),ang:TB.Thip.a+(still?0:PYL[s].ang*.5+Math.sin(t*.9+(s==='R'?1:0))*.02)};}
  place('chamber',TB.Ttor);place('domeL',TB.Td.L);place('domeR',TB.Td.R);
  // the command moon holds its own position in the world, then corrects toward its post
  {const P=PARTS.moon;if(still||!MOONP.init)T.moon={piv:ap(TB.Ttor,P.pg),ang:0};else T.moon={piv:[MOONP.x,MOONP.y+Math.sin(t*.8)*1.2],ang:MOONP.a};}
  for(const s of['L','R']){const ua=PARTS['ua'+s],fa=PARTS['fa'+s],fi=PARTS['fist'+s];const TD=TB.Td[s];const sv=still?0:L['s'+s].x,ev=still?0:L['e'+s].x,wv=still?0:L['w'+s].x;
    const Tsh=cmp(TD,about(ua.joints.a,sv));const Tel=cmp(Tsh,about(ua.joints.b,ev));const Twr=cmp(Tel,about(fa.joints.b,wv));place('ua'+s,Tsh);place('fa'+s,Tel);place('fist'+s,Twr);T['_F'+s]=ap(Twr,fi.pg);
    if(!still&&dt>0){const p=T['_F'+s];if(prevFist[s])fistVel[s]=[(p[0]-prevFist[s][0])/dt,(p[1]-prevFist[s][1])/dt];prevFist[s]=p;}}
  T._cores=[ap(TB.Ttor,[HOTC.x+CORE.x,HOTC.y+CORE.y]),ap(TB.Ttor,[COLDC.x-CORE.x*.7,COLDC.y-CORE.y*.6])];
  if(broken){const dim=.35+.25*Math.sin(t*6);drawCore(COLDC,T._cores[1][0]+OX_,T._cores[1][1]+OY_,dim);drawCore(HOTC,T._cores[0][0]+OX_,T._cores[0][1]+OY_,dim);}
  // depth: the arm that is crossing the body comes in front of the chamber
  const crossing=cur&&cur.name==='cross'?cur.rear:null;let order=ORDER.slice();if(crossing){order=order.filter(n=>!n.endsWith(crossing)||n.startsWith('dome')||n.startsWith('py'));order.push('ua'+crossing,'fa'+crossing,'fist'+crossing);}
  for(let z=0;z<order.length;z++){const n=order[z];const P=PARTS[n];if(P.gone)continue;const trn=T[n];
    if(n.startsWith('fist'))drawFist(P,trn.piv[0]+OX_,trn.piv[1]+OY_,trn.ang,z,still?1.12:L['c'+n.slice(4)].x);else drawPart(P,trn.piv[0]+OX_,trn.piv[1]+OY_,trn.ang,z);
    if(n==='chamber'&&!broken){const hc=[T._cores[0][0]+OX_,T._cores[0][1]+OY_],cc=[T._cores[1][0]+OX_,T._cores[1][1]+OY_];const lp=loopPtsK(cc,hc,hp,t),op=orbitPts({x:hc[0],y:hc[1],R:HOTC.R},t,hp);drawLoopK(lp,false,hp,t);drawLoopK(op,false,hp,t);drawCore(COLDC,cc[0],cc[1],1);drawCore(HOTC,hc[0],hc[1],1);drawLoopK(lp,true,hp,t);drawLoopK(op,true,hp,t);}}
  for(const ch of chunks){ch.x+=ch.vx*dt*60;ch.y+=ch.vy*dt*60;ch.vx*=Math.pow(.994,dt*60);ch.vy*=Math.pow(.994,dt*60);ch.a+=ch.va*dt*.6;const ca=Math.cos(ch.a),sa=Math.sin(ch.a);for(const q of ch.px){const X=ch.x+q[0]*ca-q[1]*sa,Y=ch.y+q[0]*sa+q[1]*ca;const fl=q[3]?1:(.75+.25*Math.cos(ch.a*2+q[0]));px(X,Y,q[3]?q[2]:[q[2][0]*fl|0,q[2][1]*fl|0,q[2][2]*fl|0],q[3],-1,0,0,30);}}
  if(!still){for(let y=4;y<H;y++)for(let x=3;x<W;x++){const i=y*W+x;if(!FB[i*4+3]||EM[i*4+3])continue;const j=(y-4)*W+(x-3);if(ZB[j]>ZB[i]+1){const q=i*4;FB[q]=FB[q]*.68|0;FB[q+1]=FB[q+1]*.68|0;FB[q+2]=FB[q+2]*.72|0;}}}
  frame.T=T;frame.O=[OX_,OY_];frame.TB=TB;if(still)return;
  // pylon thrust: each one independently, visibly solving momentum
  for(const s of['L','R']){const n='py'+s;const P=PARTS[n];if(P.gone)continue;const trn=T[n];const lb=[P.joints.b[0]-P.pg[0],P.joints.b[1]-P.pg[1]];const ca_=Math.cos(trn.ang),sa_=Math.sin(trn.ang);const ex=trn.piv[0]+lb[0]*ca_-lb[1]*sa_+OX_,ey=trn.piv[1]+lb[0]*sa_+lb[1]*ca_+OY_;
    const th=Math.max(.15,PYL[s].th);const a=Math.PI/2+trn.ang+PYL[s].ang;const len=16+30*th;const cnt=60+80*Math.min(2,th);for(let k=0;k<cnt;k++){const f=k/cnt;const Ln=f*len*(1+.07*Math.sin(t*9+k*.7));const w=(1-f)*(3+2*th);const X=ex+Math.cos(a)*Ln+(h3(k,Math.floor(t*14),s.charCodeAt(0))-.5)*w*Math.sin(a),Y=ey+Math.sin(a)*Ln;px(X,Y,f<.25?[230,250,255]:f<.6?[120,170,240]:[40,70,150],1,-1,0,0,30);}}
  // impact: hitstop already set; shockwave and debris where the fist lands
  if(impactInfo){const I=impactInfo;impactInfo=null;const side=I.nm==='cross'?I.rear:I.lead;let p=T['_F'+side];if(I.nm==='slam')p=[(T._FL[0]+T._FR[0])/2,(T._FL[1]+T._FR[1])/2+26];const X=p[0]+OX_+(I.nm==='slam'||I.nm==='upper'?0:I.d*24),Y=p[1]+OY_+(I.nm==='upper'?-22:0);
    rings.push({x:X,y:Y,r:4,a:1,big:I.nm==='slam'?1:0});flashes.push({x:X,y:Y,t:0,big:I.nm==='slam'?1:0});const N=I.nm==='slam'?160:70;for(let k=0;k<N;k++){const a=I.nm==='slam'?-Math.PI*Math.random():Math.random()*TAU,sp=1+Math.random()*(I.nm==='slam'?6:4);dust.push({x:X,y:Y,vx:Math.cos(a)*sp+(I.nm==='slam'?0:I.d*1.5),vy:Math.sin(a)*sp,life:1,c:k%5?RX.s1[4+(k%5)]:[255,190,110]});}}
  if(Math.random()<.4+1.5*dmg){const n=ORDER[(Math.random()*ORDER.length)|0];const P=PARTS[n];if(!P.gone){const trn=T[n];dust.push({x:trn.piv[0]+OX_+(Math.random()-.5)*P.w*.7,y:trn.piv[1]+OY_+(Math.random()-.5)*P.h*.7,vx:(Math.random()-.5)*.6,vy:(Math.random()-.5)*.6+.1,life:1,c:RX.s1[3+(Math.random()*4|0)]});}}}
// rubble fists: each piece drawn on its own, the field pulling the pieces together or letting them drift apart
function drawFist(P,px0,py0,ang,z,spread){const ca=Math.cos(ang),sa=Math.sin(ang);const wForm=Math.max(0,Math.cos(ang))**3*.82;const k=spread-1;
  for(let c=0;c<P.nchunk;c++){if(!P.alive[c]||P.cb[c*4]<0)continue;const ox=(P.cc[c*2]-P.pivX)*k*1.9,oy=(P.cc[c*2+1]-P.pivY)*k*1.9;const b=c*4;
    const cs=[[P.cb[b],P.cb[b+1]],[P.cb[b+2]+1,P.cb[b+1]],[P.cb[b],P.cb[b+3]+1],[P.cb[b+2]+1,P.cb[b+3]+1]].map(([lx,ly])=>{const u=lx-P.pivX+ox,v=ly-P.pivY+oy;return[px0+u*ca-v*sa,py0+u*sa+v*ca];});
    const x0=Math.max(0,Math.floor(Math.min(...cs.map(q=>q[0])))-1),x1=Math.min(W-1,Math.ceil(Math.max(...cs.map(q=>q[0])))+1),y0=Math.max(0,Math.floor(Math.min(...cs.map(q=>q[1])))-1),y1=Math.min(H-1,Math.ceil(Math.max(...cs.map(q=>q[1])))+1);
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){let cnt=0,best=-1;for(let s=0;s<4;s++){const dx=x+((s&1)?.75:.25)-px0,dy=y+((s&2)?.75:.25)-py0;const u=dx*ca+dy*sa-ox,v=-dx*sa+dy*ca-oy;const ix=Math.floor(u+P.pivX),iy=Math.floor(v+P.pivY);if(ix<0||iy<0||ix>=P.w||iy>=P.h)continue;const i=iy*P.w+ix;if(!P.mat[i]||P.chunk[i]!==c)continue;cnt++;best=i;}
      if(cnt<2)continue;const[col,em]=shadeAt(P,best,ca,sa,wForm,x,y);let cc=col;if(!em&&P.edge[best]<=1.01)cc=[col[0]*.55|0,col[1]*.55|0,col[2]*.6|0];
      // tight compression lights the field between the pieces
      if(!em&&spread<.9){const bind=Math.min(1,(.9-spread)*6);if(((x+y)&3)===0||(bind>.6&&((x*3+y)&7)===0))cc=[Math.min(255,cc[0]+40*bind+10),Math.min(255,cc[1]+60*bind+10),Math.min(255,cc[2]+90*bind+20)];if(P.edge[best]<=1.01&&bind>.4)cc=[150,210,255];}px(x,y,cc,em,P.i,best%P.w,(best/P.w)|0,z);}}}
// the loop, deformed by load: lobes stretch and tighten, the crossing shears, the whole figure breathes vertically
function loopPtsK(A,B,hp,t){const mx=(A[0]+B[0])/2+LOOP.sh.x*.6,my=(A[1]+B[1])/2;const dx=B[0]-A[0],dy=B[1]-A[1];const d=Math.hypot(dx,dy)||1;const ux=dx/d,uy=dy/d;const pts=[];const dmg=1-hp/100;const lf=TUNE.loop;
  for(let k=0;k<520;k++){const s=k/520*TAU;const den=1+Math.sin(s)**2;const lobe=Math.cos(s)>0?1+(LOOP.r.x-1)*lf:1+(LOOP.l.x-1)*lf;let lx=d*Math.cos(s)/den*1.3*lobe,ly=d*Math.sin(s)*Math.cos(s)/den*1.35*lobe*(1+(LOOP.vt.x-1)*lf);ly+=(1+7*dmg+STRESS*3)*(n3(k*.06,t*1.6,3)-.5);
    pts.push([mx+lx*ux-ly*uy,my+lx*uy+ly*ux,Math.sin(s)*(Math.cos(s)>0?1:-1),s]);}return pts;}
function drawLoopK(pts,front,hp,t){const dmg=1-hp/100;const br=LOOP.br.x;for(let k=0;k<pts.length;k++){const p=pts[k];if((p[2]>0)!==front)continue;if(dmg>.4&&n3(k*.2,t*6,9)<(dmg-.4)*1.2)continue;const cross=Math.abs(Math.sin(p[3]))<.1;
  let c=cross?[255,255,255]:front?(k%7<3?[248,244,255]:[214,196,255]):[150,130,220];if(br>1.15&&front)c=[255,250,255];px(p[0],p[1],c,1,-1,0,0,front?6:4);if(hp>40||br>1.2)px(p[0],p[1]+1,front?[170,140,250]:[90,80,170],1,-1,0,0,front?6:4);if(br>1.3&&front)px(p[0],p[1]-1,[200,180,255],1,-1,0,0,6);}}
