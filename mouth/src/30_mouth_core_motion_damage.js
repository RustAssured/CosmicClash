const cv=document.getElementById('cv'),gx=cv.getContext('2d');
const TUNE={slide:243,strike:1.18,lag:1,reach:.9,track:1.39};
// ---------- perimeter ----------
const PER=2*(W+H);
function edgeAt(s){s=((s%PER)+PER)%PER;const pts=[[0,0],[W,0],[W,H],[0,H]],N=[[0,1],[-1,0],[0,-1],[1,0]],L=[W,H,W,H];let e=0,a=0;while(s>a+L[e]){a+=L[e];e=(e+1)%4;}const f=(s-a)/L[e];const A=pts[e],B=pts[(e+1)%4];const p=[A[0]+(B[0]-A[0])*f,A[1]+(B[1]-A[1])*f];let n=N[e].slice();
  const dA=f*L[e],dB=(1-f)*L[e],RC=110;if(dB<RC){const k=.5*(1-dB/RC);const n2=N[(e+1)%4];n=[n[0]*(1-k)+n2[0]*k,n[1]*(1-k)+n2[1]*k];}if(dA<RC){const k=.5*(1-dA/RC);const n0=N[(e+3)%4];n=[n[0]*(1-k)+n0[0]*k,n[1]*(1-k)+n0[1]*k];}const l=Math.hypot(n[0],n[1]);return{p,n:[n[0]/l,n[1]/l]};}
// ---------- state ----------
let fightBack=true;let s=PER-H*.5,sv=0,slideIn=0,variant=0,move=null,t=0,hitstop=0,shake=0,oppMoves=true,dbg=false,hits=0;
let opp={x:470,y:170,vx:0,vy:0,flash:0,dragged:false};
const NS=24;// neck samples: authored shape + spring offsets
const neck=[];for(let i=0;i<NS;i++)neck.push({x:0,y:0,vx:0,vy:0,init:false});
let hd={x:300,y:180,vx:0,vy:0},trail=[];const HB={gape:1,gv:0,spread:0,sv:0,roll:0,rv:0,jit:.3,grind:0,pulse:0};let ringSpin=0,ringRate=1,open=1,clampV=0;
const ease={io:u=>u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2,out4:u=>1-Math.pow(1-u,4),in2:u=>u*u,out2:u=>1-(1-u)*(1-u)};
// ---------- the beats of each strike: durations, and what the head and neck intend ----------
const MOVES={bite:[['load',.42],['strike',.18],['bite',.16],['hold',.12],['recover',.7]],sweep:[['load',.38],['sweep',.5],['bite',.14],['recover',.75]],coil:[['reach',.36],['coil',.7],['crush',.4],['release',.8]]};
function begin(n){if(move)return;const ex=exitPt();move={n,ph:0,t0:t,v:variant,from:[hd.x,hd.y],tg:[opp.x,opp.y],ex};}
function exitPt(){const E=edgeAt(s);return{E,X:[E.p[0]+E.n[0]*48,E.p[1]+E.n[1]*48]};}
const ARC=1.35;
function clampArc(E,X,P){const d=[P[0]-X[0],P[1]-X[1]];let a=Math.atan2(E.n[0]*d[1]-E.n[1]*d[0],E.n[0]*d[0]+E.n[1]*d[1]);a=Math.max(-ARC,Math.min(ARC,a));const c=Math.cos(a),si=Math.sin(a);return[E.n[0]*c-E.n[1]*si,E.n[0]*si+E.n[1]*c];}
// the head's intended position and the neck's intended shape for this instant
function intent(){const{E,X}=exitPt();const D=clampArc(E,X,[opp.x,opp.y]);const perp=[-D[1],D[0]];const dOpp=Math.hypot(opp.x-X[0],opp.y-X[1]);
  const idleL=Math.min(230,dOpp*.55);let H_=[X[0]+D[0]*idleL+Math.sin(t*.8)*8,X[1]+D[1]*idleL+Math.cos(t*.7)*8];let bend=Math.sin(t*.9)*.35+.25,coilAmp=0,label='watching',spin=1,op=1,cl=0,stiff=1;
  if(move){const seq=MOVES[move.n];let[ph,du]=seq[move.ph];du/=(ph==='strike'||ph==='sweep'?TUNE.strike*(move.v===1?1.3:move.v===-1?.85:1):1);let u=(t-move.t0)/du;
    while(u>=1){move.ph++;move.t0+=du;if(move.ph>=seq.length){move=null;break;}[ph,du]=seq[move.ph];du/=(ph==='strike'||ph==='sweep'?TUNE.strike*(move.v===1?1.3:move.v===-1?.85:1):1);u=(t-move.t0)/du;if(ph==='bite'||ph==='crush'){hitstop=.11;shake=13;spawnImpact(hd.x,hd.y);const d=Math.hypot(hd.x-opp.x,hd.y-opp.y);if(d<70){opp.flash=1;hits++;shake=10;}}}
    if(move){const tg=move.tg;const dT=Math.hypot(tg[0]-X[0],tg[1]-X[1]);const Dt=clampArc(E,X,tg);const reach=Math.max(80,Math.min(dT,520*TUNE.reach*(move.v===-1?1.12:move.v===1?.88:1)));const strikeP=[X[0]+Dt[0]*reach,X[1]+Dt[1]*reach];const v=move.v;const pp=[-Dt[1],Dt[0]];label=ph;
      if(move.n==='bite'){
        if(ph==='load'){// coil back into the body, low and to the side — the tell
          const e=ease.io(u);const back=[X[0]+Dt[0]*90+pp[0]*(v*-60+40),X[1]+Dt[1]*90+pp[1]*(v*-60+40)];const midP=[(back[0]+strikeP[0])/2+pp[0]*v*-200,(back[1]+strikeP[1])/2+pp[1]*v*-200];move.path=[back,midP,strikeP];H_=[H_[0]+(back[0]-H_[0])*e,H_[1]+(back[1]-H_[1])*e];coilAmp=26*e;bend=.9*e*(v||1);spin=1+3*e;op=1+.4*e;stiff=1.4;}
        if(ph==='strike'){// out along an arc: high goes over, low comes under
          const e=ease.out4(u);const back=[X[0]+Dt[0]*90+pp[0]*(v*-60+40),X[1]+Dt[1]*90+pp[1]*(v*-60+40)];const mid=[(back[0]+strikeP[0])/2+pp[0]*v*-200,(back[1]+strikeP[1])/2+pp[1]*v*-200];move.path=[back,mid,strikeP];
          const q=1-e;H_=[q*q*back[0]+2*q*e*mid[0]+e*e*strikeP[0],q*q*back[1]+2*q*e*mid[1]+e*e*strikeP[1]];bend=-.3*v;spin=4;op=1.5;stiff=2.2;}
        if(ph==='bite'||ph==='hold'){H_=strikeP;spin=.3;op=.5;cl=1;stiff=2.2;bend=0;}
        if(ph==='recover'){const e=ease.io(u);H_=[strikeP[0]+(H_[0]-strikeP[0])*e,strikeP[1]+(H_[1]-strikeP[1])*e];spin=1;op=.8;stiff=.8;}}
      if(move.n==='sweep'){const side=v===0?1:v;const R_=Math.min(reach,420);const a0=Math.atan2(Dt[1],Dt[0])-1.1*side,a1=Math.atan2(Dt[1],Dt[0])+1.1*side;
        if(ph==='load'){const e=ease.io(u);const P0=[X[0]+Math.cos(a0)*150,X[1]+Math.sin(a0)*150];H_=[H_[0]+(P0[0]-H_[0])*e,H_[1]+(P0[1]-H_[1])*e];coilAmp=18*e;bend=.8*side*e;spin=1+3*e;op=1.3;stiff=1.3;}
        if(ph==='sweep'){const e=ease.io(u);const a=a0+(a1-a0)*e;const r=150+(R_-150)*Math.sin(Math.min(1,e*1.3)*Math.PI*.5);H_=[X[0]+Math.cos(a)*r,X[1]+Math.sin(a)*r];spin=4;op=1.5;stiff=2;bend=-.5*side;}
        if(ph==='bite'){H_=[X[0]+Math.cos(a1)*R_,X[1]+Math.sin(a1)*R_];cl=1;op=.5;spin=.3;stiff=2;}
        if(ph==='recover'){const e=ease.io(u);const P1=[X[0]+Math.cos(a1)*R_,X[1]+Math.sin(a1)*R_];H_=[P1[0]+(H_[0]-P1[0])*e,P1[1]+(H_[1]-P1[1])*e];stiff=.8;}}
      if(move.n==='coil'){const side=v===0?1:v;
        if(ph==='reach'){const e=ease.out2(u);const past=[tg[0]+Dt[0]*70+pp[0]*side*50,tg[1]+Dt[1]*70+pp[1]*side*50];H_=[move.from[0]+(past[0]-move.from[0])*e,move.from[1]+(past[1]-move.from[1])*e];stiff=1.8;spin=2;bend=.6*side;}
        if(ph==='coil'||ph==='crush'){const r=ph==='coil'?75-35*u:40;const ang=Math.atan2(Dt[1],Dt[0])+side*(Math.PI*.4+(ph==='coil'?u:1)*Math.PI*1.7);H_=[tg[0]+Math.cos(ang)*r,tg[1]+Math.sin(ang)*r];stiff=1.6;spin=ph==='crush'?.3:2;cl=ph==='crush'?1:0;op=ph==='crush'?.5:1.1;
          move.wrap=[tg[0],tg[1],r,ang,side];}
        if(ph==='release'){const e=ease.io(u);H_=[hd.x+(H_[0]-hd.x)*e*.2,hd.y+(H_[1]-hd.y)*e*.2];stiff=.7;move.wrap=null;}}}}
  // the end: convulse, go slack, and be dragged back over the edge — or, severed, let the head drift away
  if(DMG.ko){const k=t-DMG.ko.t0;label='ko';move=null;spin=k<.9?6:Math.max(0,1-k);
    if(DMG.ko.type==='drag'){if(k<.9){H_=[hd.x+Math.sin(k*40)*6,hd.y+Math.cos(k*33)*6];stiff=2;}else if(k<2.2){H_=[X[0]+E.n[0]*120,X[1]+E.n[1]*120+60];stiff=.35;}else{const f=Math.min(1,(k-2.2)/3);H_=[X[0]-E.n[0]*260*f,X[1]-E.n[1]*260*f+40*(1-f)];stiff=.6;koDrag=f;}}
    else{const f=Math.min(1,k/1.6);H_=[X[0]+E.n[0]*(140-120*f),X[1]+E.n[1]*(140-120*f)];stiff=1.2;koDrag=Math.max(0,(k-2.5)/3);}
    if(k>8.5)restore();
    return{E,X,H_,bend:.2,coilAmp:k<.9?30:0,label,spin,op:k<.9?1.6:1.3,cl:0,stiff,gp:k<.9?1.2+Math.sin(k*30)*.5:1.5,spr:k<.9?.8:-1,rollT:k<.9?Math.sin(k*20)*2:0,jt:k<.9?3:0,gr:0};}
  H_=[Math.max(50,Math.min(W-50,H_[0])),Math.max(50,Math.min(H-50,H_[1]))];// the head stays in the arena
  // how the head behaves in each beat: breathing and twitching at rest, an iris of rings opening in the wind-up, snapping shut and grinding in the bite
  let gp=1+.14*Math.sin(t*.9)*Math.sin(t*.31+1)+(Math.sin(t*4.1)>.985?.12:0),spr=.08*Math.sin(t*.5),rollT=Math.sin(t*.32)*.25,jt=.12,gr=0;
  if(label==='load'||label==='reach'){gp=1.5;spr=1.05;rollT=1.1;jt=.6;}
  if(label==='strike'||label==='sweep'){gp=1.55;spr=-.3;rollT=2.0;jt=.3;}
  if(label==='bite'||label==='hold'||label==='crush'){gp=.42;spr=-.4;rollT=2.4;jt=1.0;gr=1;}
  if(label==='coil'){gp=1.25;spr=.35;rollT=1.8;jt=.5;}
  if(label==='recover'||label==='release'){gp=.95;spr=.15;rollT=.6;jt=.35;}
  return{E,X,H_,bend,coilAmp,label,spin,op,cl,stiff,gp,spr,rollT,jt,gr};}
// ---------- step ----------
function step(dt){t+=dt;
  // sliding: heavy — it takes a moment to get going and a moment to stop; corners are slower
  const hq=DMG.hp/100;const E0=edgeAt(s);const corner=Math.abs(Math.abs(E0.n[0])-Math.abs(E0.n[1]))<.9?.55:1;const want=slideIn*TUNE.slide*(.55+.45*hq)*corner*(move||DMG.ko?.2:1);sv+=(want-sv)*Math.min(1,dt*2.2);s=((s+sv*dt)%PER+PER)%PER;
  // the opponent drifts about the arena
  if(oppMoves&&!opp.dragged){opp.vx+=(Math.sin(t*.37)*60-opp.vx)*dt*.5;opp.vy+=(Math.cos(t*.29)*45-opp.vy)*dt*.5;opp.x+=opp.vx*dt;opp.y+=opp.vy*dt;opp.x=Math.max(130,Math.min(W-130,opp.x));opp.y=Math.max(80,Math.min(H-80,opp.y));}
  opp.flash*=Math.pow(.05,dt);
  if(fightBack&&!DMG.ko&&step.I&&['recover','release'].includes(step.I.label)&&Math.random()<dt*1.4&&HITN.length){const q=HITN[Math.floor(HITN.length*(.35+Math.random()*.5))];if(q)hitAt(q.x,q.y,1+Math.random());}
  if(fightBack&&!DMG.ko&&!move&&Math.random()<dt*.35){if(Math.random()<.5)hitAt(hd.x+(Math.random()-.5)*30,hd.y+(Math.random()-.5)*30,1);else if(HITC.length){const q=HITC[Math.floor(Math.random()*HITC.length)];hitAt(q.x,q.y,1);}}
  const I=intent();
  // the head follows its intent with weight: fast when striking, slow and heavy otherwise
  const k=(move||DMG.ko?28*I.stiff:7*TUNE.track*(.5+.5*hq))/(TUNE.lag*(1+.8*(1-hq)));const c=2*.9*Math.sqrt(k);hd.vx+=(k*(I.H_[0]-hd.x)-c*hd.vx)*dt;hd.vy+=(k*(I.H_[1]-hd.y)-c*hd.vy)*dt;{const vm=Math.hypot(hd.vx,hd.vy),cap=move&&['strike','sweep'].includes(step.I&&step.I.label)?1300:520;if(vm>cap){hd.vx*=cap/vm;hd.vy*=cap/vm;}}hd.x+=hd.vx*dt;hd.y+=hd.vy*dt;
  const sp=Math.hypot(hd.vx,hd.vy);if(sp>420)trail.push({x:hd.x,y:hd.y,a:1});for(const q of trail)q.a-=dt*4;trail=trail.filter(q=>q.a>0);
  // the gape snaps (an underdamped spring); the iris and the roll are heavy; the pulse quickens with tension
  HB.gv+=(210*(I.gp-HB.gape)-2*.46*Math.sqrt(210)*HB.gv)*dt;HB.gape+=HB.gv*dt;HB.sv+=(90*(I.spr-HB.spread)-2*.55*Math.sqrt(90)*HB.sv)*dt;HB.spread+=HB.sv*dt;
  HB.rv+=(22*(I.rollT-HB.roll)-2*.8*Math.sqrt(22)*HB.rv)*dt;HB.roll+=HB.rv*dt;HB.jit+=(I.jt+(1-hq)*1.2-HB.jit)*Math.min(1,dt*6);HB.grind+=(I.gr-HB.grind)*Math.min(1,dt*(I.gr>HB.grind?20:3));
  HB.pulse=.018*Math.sin(t*(2.2+HB.jit*3))*(.6+HB.jit*.4);
  ringSpin+=dt*ringRate;ringRate+=(I.spin-ringRate)*Math.min(1,dt*6);open+=(I.op-open)*Math.min(1,dt*10);clampV+=(I.cl-clampV)*Math.min(1,dt*(I.cl>clampV?18:5));
  // the neck: an authored curve from the coils to the head, plus heavy lag per sample
  const{E,X}=I;const n=E.n;const hx=hd.x,hy=hd.y;const L=Math.hypot(hx-X[0],hy-X[1])||1;const dir=[(hx-X[0])/L,(hy-X[1])/L];const pp=[-dir[1],dir[0]];
  const c1=[X[0]+n[0]*L*.42+pp[0]*I.bend*L*.35,X[1]+n[1]*L*.42+pp[1]*I.bend*L*.35],c2=[hx-dir[0]*L*.35-pp[0]*I.bend*L*.2,hy-dir[1]*L*.35-pp[1]*I.bend*L*.2];
  for(let i=0;i<NS;i++){const f=i/(NS-1),q=1-f;let tx=q*q*q*X[0]+3*q*q*f*c1[0]+3*q*f*f*c2[0]+f*f*f*hx,ty=q*q*q*X[1]+3*q*q*f*c1[1]+3*q*f*f*c2[1]+f*f*f*hy;
    // bunching in the wind-up: the neck folds into tight waves
    const wv=Math.sin(f*Math.PI*3-t*2)*I.coilAmp*Math.sin(f*Math.PI)+Math.sin(f*7-t*1.7)*5*Math.sin(f*Math.PI);tx+=pp[0]*wv;ty+=pp[1]*wv;
    // wrapping: the last third of the neck follows the circle round the opponent
    if(move&&move.wrap&&f>.55){const[wx,wy,r,ang,side]=move.wrap;const a=ang-side*(1-(f-.55)/.45)*Math.PI*1.4;const k2=Math.min(1,(f-.55)/.2);tx=tx+(wx+Math.cos(a)*r-tx)*k2;ty=ty+(wy+Math.sin(a)*r-ty)*k2;}
    const N=neck[i];if(!N.init){N.x=tx;N.y=ty;N.init=true;}const ks=(i<2?400:(150*(1-.72*Math.sin(f*Math.PI)))*(move?1.5:1))/TUNE.lag;const cs=2*.95*Math.sqrt(ks);N.vx+=(ks*(tx-N.x)-cs*N.vx)*dt;N.vy+=(ks*(ty-N.y)-cs*N.vy)*dt;N.x+=N.vx*dt;N.y+=N.vy*dt;}
  neck[NS-1].x=hx;neck[NS-1].y=hy;neck[0].x=X[0];neck[0].y=X[1];
  hitstop=Math.max(0,hitstop);shake*=Math.pow(.03,dt);stepParts(dt);
  if(DMG.ko&&DMG.ko.type==='sever'){LOOSE.x+=LOOSE.vx*dt;LOOSE.y+=LOOSE.vy*dt;LOOSE.vy+=6*dt;LOOSE.roll+=LOOSE.vr*dt;}
  step.I=I;}
// ---------- draw: the full look, on the feel logic ----------
// ---------- damage: teeth snap, rings chip and break, strands tear and sever, coils gash; control degrades; then the end ----------
const DMG={hp:100,broken:new Set(),ringHp:[5,5,5,5],ringGaps:[[],[],[],[]],sever:[0,0,0,0,0,0],severF:[1,1,1,1,1,1],ko:null};
let HITN=[],HITC=[];// sample points of neck and coil strands, refreshed when drawn, for hit lookup
function hitAt(x,y,power=1){if(DMG.ko)return false;const dh=Math.hypot(x-hd.x,y-hd.y);let what=null;
  // nearest: head, neck strand, coil strand
  let bn=null,bnd=1e9;for(const q of HITN){const d=Math.hypot(q.x-x,q.y-y);if(d<bnd){bnd=d;bn=q;}}let bc=null,bcd=1e9;for(const q of HITC){const d=Math.hypot(q.x-x,q.y-y);if(d<bcd){bcd=d;bc=q;}}
  if(dh<Rh*1.35&&dh<bnd)what='head';else if(bn&&bnd<22&&bnd<=bcd)what='neck';else if(bc&&bcd<40)what='coil';if(!what)return false;
  const stretched=(step.I&&['strike','bite','hold','recover','sweep','release'].includes(step.I.label));let dmg=0;
  if(what==='head'){// snap a few teeth; chip the nearest ring; break it if it has taken enough
    for(let k=0;k<3+power*2;k++){const r=Math.random();DMG.broken.add(r<.5?'t'+Math.floor(Math.random()*5)+'_'+Math.floor(Math.random()*11):'r'+Math.floor(Math.random()*4)+'_'+6*Math.floor(Math.random()*40));}
    const gi=Math.floor(Math.random()*4);if(DMG.ringHp[gi]>0){DMG.ringHp[gi]-=power;DMG.ringGaps[gi].push([Math.random(),.03+.03*power]);if(DMG.ringHp[gi]<=0)burst(hd.x,hd.y,60,2);}
    burst(x,y,25+15*power,2);dmg=4*power;}
  if(what==='neck'){const k=bn.k;DMG.sever[k]+=power*(stretched?1.6:1);WOUNDS.push({sid:30+k,u:bn.u,len:7+power*3});if(DMG.sever[k]>=2.5&&DMG.severF[k]>=1)DMG.severF[k]=bn.f;burst(x,y,30+10*power,1);dmg=5*power*(stretched?1.6:1);}
  if(what==='coil'){WOUNDS.push({sid:bc.sid,u:bc.u,len:9+power*4});burst(x,y,20,1);dmg=2*power;}
  if(WOUNDS.length>60)WOUNDS.shift();DMG.hp=Math.max(0,DMG.hp-dmg);shake=Math.max(shake,4+power*3);hitstop=Math.max(hitstop,.04*power);
  if(DMG.hp<=0)knockout();return true;}
function burst(x,y,n,kind){for(let k=0;k<n;k++){const a=Math.random()*TAU,sp=30+Math.random()*180;PARTS.push({x,y,px:x,py:y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:.6+Math.random(),kind,sz:kind===0?2:kind===1?2:1});}}
function knockout(){if(DMG.ko)return;const severed=DMG.severF.filter(f=>f<1).length;DMG.ko={t0:t,type:severed>=3?'sever':'drag'};move=null;hitstop=.25;shake=16;spawnImpact(hd.x,hd.y);
  if(DMG.ko.type==='sever'){LOOSE.x=hd.x;LOOSE.y=hd.y;LOOSE.vx=hd.vx*.3+(Math.random()-.5)*40;LOOSE.vy=hd.vy*.3+20;LOOSE.roll=0;LOOSE.vr=(Math.random()-.5)*2;}}
const LOOSE={x:0,y:0,vx:0,vy:0,roll:0,vr:0};
function restore(){DMG.hp=100;DMG.broken.clear();DMG.ringHp=[5,5,5,5];DMG.ringGaps=[[],[],[],[]];DMG.sever=[0,0,0,0,0,0];DMG.severF=[1,1,1,1,1,1];DMG.ko=null;WOUNDS.length=0;koDrag=0;}
let koDrag=0;
const PARTS=[],SHOCK=[];const FLASH=[];function spawnImpact(x,y){SHOCK.push({x,y,r:10,a:1.1,w:3},{x,y,r:2,a:1.3,w:2},{x,y,r:30,a:.8,w:1});FLASH.push({x,y,r:34,a:1});
  for(let k=0;k<170;k++){const a=Math.random()*TAU,sp=(k<60?30+Math.random()*160:50+Math.random()*260);const kind=k<60?0:k<130?1:2;
    PARTS.push({x:x+Math.cos(a)*8,y:y+Math.sin(a)*8,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,life:.8+Math.random()*1.6,kind,sz:kind===0?2+Math.floor(Math.random()*4):kind===1?2:1,px:x,py:y});}}
function stepParts(dt){for(const p of PARTS){p.px=p.x;p.py=p.y;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=Math.pow(.12,dt);p.vy*=Math.pow(.12,dt);if(p.kind===1)p.vy+=40*dt;p.life-=dt;}for(let i=PARTS.length-1;i>=0;i--)if(PARTS[i].life<=0)PARTS.splice(i,1);for(const q of SHOCK){q.r+=420*dt;q.a-=dt*1.4;}for(const f of FLASH){f.r+=160*dt;f.a-=dt*3.2;}for(let i=FLASH.length-1;i>=0;i--)if(FLASH[i].a<=0)FLASH.splice(i,1);for(let i=SHOCK.length-1;i>=0;i--)if(SHOCK[i].a<=0)SHOCK.splice(i,1);}
const Rh=58;const BFB=new Uint8ClampedArray(W*H*4),BEM=new Uint8ClampedArray(W*H*4),BZB=new Float32Array(W*H);let bAge=99,bS=-1;
function drawBundleF(pay){clr();const s_=Math.sin;const offs=[-330,-240,-150,-70,0,80,160,250,340];const depth=[-130,-40,-100,0,-50+pay*20,8,-95,-30,-130].map(v=>v-koDrag*150);
  const P=offs.map((o,i)=>{const e=edgeAt(s+o*(1-pay*.18));const dd=depth[i]*(1-pay*.35)+s_(t*.32+i*1.3)*12;return[e.p[0]+e.n[0]*dd,e.p[1]+e.n[1]*dd,62+s_(t*.3+i)*10];});
  const main=braidPaths(P,{n:4,step:6,br:f=>35+5*Math.sin(f*9+t*.4),sr:(f,k)=>27+5*Math.sin(f*7+k*2+t*.5)+4*Math.sin(f*23+k),twist:.02,writhe:.3+pay*.5,wob:9,sid:10,phase:-pay*3},t);
  HITC=[];main.forEach((path,k)=>{const sub=braidPaths(asSpine(path),{n:4,br:(f,S)=>S.r*.5,sr:(f,j,S)=>S.r*(.5+.1*Math.sin(f*17+j*2.1+k)),twist:.05,writhe:.5,wob:3,sid:100+k*3},t);sub.forEach((q,j)=>{drawPath(q,100+k*3+j,.1);for(let i=0;i<q.length;i+=4)HITC.push({x:q[i].p[0],y:q[i].p[1],sid:100+k*3+j,u:q[i].s});});});
  for(let k=0;k<5;k++){const A=main[k%4],Bp=main[(k+1)%4];const i=Math.floor((k*.19+.12)*A.length)%A.length;const pa=A[i],pb=Bp[Math.min(Bp.length-1,i+2)];if(pa&&pb&&Math.hypot(pa.p[0]-pb.p[0],pa.p[1]-pb.p[1])<90)slime([pa.p[0],pa.p[1],pa.p[2]+pa.r*.7],[pb.p[0],pb.p[1],pb.p[2]+pb.r*.7],8+k*2,t,k*13+3);}
  BFB.set(FB);BEM.set(EM);BZB.set(ZB);bS=s;}
function ringPx(cx,cy,r,col,em,z){const n=Math.ceil(TAU*r);for(let k=0;k<n;k++){const a=k/n*TAU;const X=Math.round(cx+Math.cos(a)*r),Y=Math.round(cy+Math.sin(a)*r);if(X>=0&&Y>=0&&X<W&&Y<H)put(X,Y,z,col,em);}}
function draw(){const I=step.I;const{E,X}=I;
  // the coils: redrawn a few times a second, or when the body slides
  const pay=Math.min(1,Math.max(0,(Math.hypot(hd.x-X[0],hd.y-X[1])-200)/300));bAge+=1;if(bAge>3||Math.abs(s-bS)>4||DMG.ko){drawBundleF(pay);bAge=0;}
  FB=new Uint8ClampedArray(BFB);EM=new Uint8ClampedArray(BEM);ZB=new Float32Array(BZB);
  for(let k=0;k<6;k++){const r=rng(k*13+5);rock((r()*640+t*3*(k%3+1))%700-30,r()*360,3+r()*6,-200,k);}
  // the opponent stand-in, in the depth buffer behind the head
  for(let y=Math.floor(opp.y-58);y<=opp.y+58;y++)for(let x=Math.floor(opp.x-46);x<=opp.x+46;x++){const dx=(x-opp.x)/46,dy=(y-opp.y)/58;const r2=dx*dx+dy*dy;if(r2>1||x<0||y<0||x>=W||y>=H)continue;const nz=Math.sqrt(1-r2);const l=Math.max(0,-dx*.4-dy*.5+nz*.7);
    put(x,y,-40+nz*20,opp.flash>.15?[255,236,220]:[(28+60*l)|0,(40+70*l)|0,(56+90*l)|0],opp.flash>.15?1:0);}
  // the neck: the feel's samples, up to where the funnel begins; a swallowing bulge travels up it
  const hx=hd.x,hy=hd.y;const back=neck[NS-4];let ax=hx-back.x,ay=hy-back.y;const al=Math.hypot(ax,ay)||1;ax/=al;ay/=al;const a3=[ax*.85,ay*.85,.52];const HL=Rh*1.9;
  const sev=DMG.ko&&DMG.ko.type==='sever';const B=sev?[hx,hy,20]:[hx-ax*.85*HL,hy-ay*.85*HL,20-.52*HL];const nodes=[];for(let i=0;i<NS;i++){const q=neck[i];if(!sev&&Math.hypot(q.x-hx,q.y-hy)<HL*.92&&i>2)break;nodes.push([q.x,q.y,40-i*.8+Math.sin(t+i*.5)*4]);}nodes.push(B);
  if(nodes.length>=4){const sw=(t*.3)%1.3;const vol=Math.max(.82,Math.min(1.22,Math.sqrt(250/Math.max(120,nodes.reduce((a,q,i)=>i?a+Math.hypot(q[0]-nodes[i-1][0],q[1]-nodes[i-1][1]):0,0)))));const np=braidPaths(nodes,{n:8,step:3,br:f=>((25-7*f)+Math.max(0,(f-.88)/.12)*7)*vol,sr:(f,k)=>(14.5-4.5*f)*vol*(1+.2*Math.sin(k*1.7+f*9))*(1+.25*Math.exp(-Math.pow((f-sw)/.08,2))),twist:.034,writhe:.7,wob:4,sid:30,phase:-pay*4},t);
    HITN=[];np.forEach((q,k)=>{const cut=k<6?DMG.severF[k]:Math.min(DMG.severF[k-6],DMG.severF[(k-4)%6]);let path=q;if(cut<1){path=q.filter(p=>p.f<cut);const e=path[path.length-1];if(e){for(let j=0;j<8;j++){const X_=Math.round(e.p[0]+(Math.random()-.5)*e.r*1.6),Y_=Math.round(e.p[1]+(Math.random()-.5)*e.r*1.6+j*.6);if(X_>=0&&Y_>=0&&X_<W&&Y_<H)put(X_,Y_,e.p[2]+e.r+1,j%3?[220,40,30]:[255,120,80],1);}
        const dl=Math.round(8+6*Math.sin(t*2+k));for(let j=0;j<dl;j++){const Y_=Math.round(e.p[1]+e.r+j);if(Y_<H)put(Math.round(e.p[0]),Y_,e.p[2]+e.r,j===dl-1?[255,200,190]:[150,30,40],0);}}}
      if(path.length>1)drawPath(path,30+k,0,{barbs:5});for(let i=0;i<path.length;i+=3)HITN.push({x:path[i].p[0],y:path[i].p[1],k,f:path[i].f,u:path[i].s});});for(let k=0;k<4;k++){const A=np[k%6],Bp=np[(k+2)%6];const i=Math.floor((.15+k*.17)*A.length);const pa=A[i],pb=Bp[Math.min(Bp.length-1,i+1)];if(pa&&pb){const dd=Math.hypot(pa.p[0]-pb.p[0],pa.p[1]-pb.p[1]);if(dd>6&&dd<45)slime(pa.p,pb.p,4+k,t,k*5+50);}}}
  const hq_=DMG.hp/100;const ringStop=DMG.ko?Math.max(0,1-(t-DMG.ko.t0)):1;
  if(DMG.ko&&DMG.ko.type==='sever'){const lx=LOOSE.x,ly=LOOSE.y;head([lx,ly,20],V.norm([Math.cos(LOOSE.roll*.5)*.8,Math.sin(LOOSE.roll*.5)*.8,.5]),Rh,t,{neckR:17,open:1.4,rs:.75,spinT:ringSpin,len:1.9,roll:LOOSE.roll,gape:1.5,spread:-.6,jit:0,broken:DMG.broken,ringHp:DMG.ringHp.map((h,i)=>t-DMG.ko.t0>1+i*.6?0:h),ringGaps:DMG.ringGaps});}
  else head([hx,hy,20],a3,Rh,t,{broken:DMG.broken,ringHp:DMG.ko?DMG.ringHp.map((h,i)=>t-DMG.ko.t0>2.5+i*.5?0:h):DMG.ringHp,ringGaps:DMG.ringGaps,neckR:24,open,rs:(1-clampV*.24)*(DMG.ko?Math.max(.45,1-(t-DMG.ko.t0)*.25):1),spinT:ringSpin,len:1.9,roll:HB.roll,gape:Math.max(.3,HB.gape),spread:HB.spread,jit:HB.jit,grind:HB.grind,pulse:HB.pulse});
  // readability: the tell (a pulsing red ring), the speed echo, the bite flash
  const lab=step.I.label;if(move&&(lab==='load'||lab==='reach'))ringPx(hx,hy,Rh*1.5,[255,90,70],1,90);
  for(const q of trail)if(q.a>.3)ringPx(q.x,q.y,Rh*.55,[220,170,170],0,-10);
  // debris: rock (dark), slime (pink, falling), bone sparks (white, glowing)
  for(const p of PARTS){const X=Math.round(p.x),Y=Math.round(p.y);const c=p.kind===0?[78,64,76]:p.kind===1?[230,140,150]:[255,240,220];
    // slime and sparks leave streaks along their flight; rock tumbles as lumps with a lit edge
    if(p.kind>0){const n=Math.ceil(Math.hypot(p.x-p.px,p.y-p.py)*1.5)+1;for(let k=0;k<=n;k++){const XX=Math.round(p.px+(p.x-p.px)*k/n),YY=Math.round(p.py+(p.y-p.py)*k/n);if(XX>=0&&YY>=0&&XX<W&&YY<H)put(XX,YY,220,k===n?c:p.kind===1?[150,60,74]:[255,170,110],p.kind===2?1:0);}}
    else for(let dy=0;dy<p.sz;dy++)for(let dx=0;dx<p.sz;dx++)if(X+dx>=0&&Y+dy>=0&&X+dx<W&&Y+dy<H)put(X+dx,Y+dy,220,dy===0&&dx===p.sz-1?[200,170,170]:c,0);}
  for(const f of FLASH){const BANDS=[[255,255,248],[255,236,190],[255,180,110],[230,90,60],[140,30,40]];for(let y=Math.floor(f.y-f.r);y<=f.y+f.r;y++)for(let x=Math.floor(f.x-f.r);x<=f.x+f.r;x++){if(x<0||y<0||x>=W||y>=H)continue;const ang=Math.atan2(y-f.y,x-f.x);const spike=1+.35*Math.pow(Math.abs(Math.sin(ang*5+f.x)),8);const dd=Math.hypot(x-f.x,y-f.y)/(f.r*spike);if(dd>1)continue;
    const bi=Math.min(4,Math.floor((dd/Math.max(.2,f.a))*4+(((x*3+y)&3)/4)*.9));if(dd>f.a&&((x+y)&1))continue;put(x,y,240,BANDS[bi],1);}}
  // shockwaves: a ring of torn space round the bite
  for(const q of SHOCK){const n=Math.ceil(TAU*q.r);for(let k=0;k<n;k+=1){if(Math.random()>q.a*.9)continue;const a=k/n*TAU;for(let ww=0;ww<(q.w||1);ww++){const X=Math.round(q.x+Math.cos(a)*(q.r-ww)),Y=Math.round(q.y+Math.sin(a)*(q.r-ww)*.7);if(X>=0&&Y>=0&&X<W&&Y<H)put(X,Y,230,q.a>.7?[255,245,235]:[255,150,120],1);}}}
  compose(gx,t);
  // the predicted path in the wind-up, so both players can read the height
  if(move&&move.path&&lab==='load'){const[a,m,b]=move.path;gx.save();gx.setLineDash([4,5]);gx.strokeStyle='rgba(255,140,110,.55)';gx.lineWidth=2;gx.beginPath();gx.moveTo(a[0],a[1]);gx.quadraticCurveTo(m[0],m[1],b[0],b[1]);gx.stroke();gx.restore();}
  if(dbg){gx.fillStyle='#efe2d6';gx.font='10px monospace';gx.fillText((move?move.n+' · ':'')+lab,hx-30,hy-70);}
  if(shake>.4){const im=gx.getImageData(0,0,W,H);gx.putImageData(im,Math.round((Math.random()-.5)*shake),Math.round((Math.random()-.5)*shake));}}
// ---------- input ----------
const keys={};const $=id=>document.getElementById(id);
document.addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(document.activeElement===cv&&['a','d','w','s','j','k','l',' ','arrowleft','arrowright','arrowup','arrowdown'].includes(k))e.preventDefault();if(keys[k])return;keys[k]=true;
  if(k==='j'||k===' ')begin('bite');if(k==='k')begin('sweep');if(k==='l')begin('coil');});
document.addEventListener('keyup',e=>{keys[e.key.toLowerCase()]=false;});
const hold=(id,v)=>{const el=$(id);el.addEventListener('pointerdown',e=>{e.preventDefault();btnSlide=v;});['pointerup','pointerleave','pointercancel'].forEach(ev=>el.addEventListener(ev,()=>{if(btnSlide===v)btnSlide=0;}));};let btnSlide=0;hold('bL',-1);hold('bR',1);
let btnVariant=0;document.querySelectorAll('.v').forEach(b=>b.onclick=()=>{btnVariant=+b.dataset.v;document.querySelectorAll('.v').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));});
$('sBite').onclick=()=>begin('bite');$('hHead').onclick=()=>hitAt(hd.x,hd.y,2);$('hNeck').onclick=()=>{const q=HITN[Math.floor(HITN.length*.5)];if(q)hitAt(q.x,q.y,2);};$('hKO').onclick=()=>{DMG.hp=0;knockout();};$('hR').onclick=()=>restore();$('bFight').onclick=()=>{fightBack=!fightBack;$('bFight').setAttribute('aria-pressed',String(fightBack));};$('sSweep').onclick=()=>begin('sweep');$('sCoil').onclick=()=>begin('coil');
$('bOpp').onclick=()=>{oppMoves=!oppMoves;$('bOpp').setAttribute('aria-pressed',String(oppMoves));};$('bDbg').onclick=()=>{dbg=!dbg;$('bDbg').setAttribute('aria-pressed',String(dbg));};
for(const[id,key,sc] of[['tSlide','slide',1],['tStrike','strike',100],['tLag','lag',100],['tReach','reach',100],['tTrack','track',100]]){const el=$(id),o=el.nextElementSibling;el.addEventListener('input',()=>{TUNE[key]=el.value/sc;o.textContent=sc===1?el.value:(el.value/sc).toFixed(2);});}
const toC=e=>{const r=cv.getBoundingClientRect();return[(e.clientX-r.left)/r.width*W,(e.clientY-r.top)/r.height*H];};
cv.addEventListener('pointerdown',e=>{const p=toC(e);if(Math.hypot(p[0]-opp.x,p[1]-opp.y)<60){opp.dragged=true;cv.setPointerCapture(e.pointerId);}else hitAt(p[0],p[1],1.4);cv.focus();});cv.addEventListener('pointermove',e=>{if(opp.dragged){const p=toC(e);opp.x=p[0];opp.y=p[1];}});cv.addEventListener('pointerup',()=>{opp.dragged=false;});
let padPrev={};function readPad(){const gp=navigator.getGamepads?navigator.getGamepads()[0]:null;if(!gp)return null;const ax=gp.axes[0]||0;const b=i=>gp.buttons[i]&&gp.buttons[i].pressed;const r={slide:Math.abs(ax)>.2?ax:(b(14)?-1:b(15)?1:0),v:b(12)?-1:b(13)?1:((gp.axes[1]||0)<-.5?-1:(gp.axes[1]||0)>.5?1:0)};
  for(const[i,m] of[[0,'bite'],[2,'sweep'],[1,'coil']]){if(b(i)&&!padPrev[i])begin(m);padPrev[i]=b(i);}return r;}
// ---------- loop: steady 60 Hz simulation, drawing as fast as the CPU renderer allows ----------
let last=0,simAcc=0,ms=0;function loop(now){requestAnimationFrame(loop);let dt=Math.min(.1,last?(now-last)/1000:0);last=now;
  const pad=readPad();slideIn=(keys.a||keys.arrowleft?-1:0)+(keys.d||keys.arrowright?1:0)+btnSlide+(pad?pad.slide:0);slideIn=Math.max(-1,Math.min(1,slideIn));
  variant=(keys.w||keys.arrowup)?-1:(keys.s||keys.arrowdown)?1:(pad&&pad.v)?pad.v:btnVariant;
  simAcc+=dt;while(simAcc>=1/60){let h=1/60;if(hitstop>0){hitstop-=h;h*=.05;}step(h);simAcc-=1/60;}
  const a0=performance.now();draw();ms=ms*.85+(performance.now()-a0)*.15;$('st').textContent=(DMG.ko?'knocked out — ':'health '+Math.round(DMG.hp)+'% · ')+hits+' bites landed · '+ms.toFixed(0)+' ms to draw a frame (CPU prototype; the game draws on the GPU)';}
window.__F={DMG,hitAt,knockout,restore,get HITN(){return HITN;},lab:()=>step.I.label+(typeof move!=='undefined'&&move?':'+move.n:''),step,draw,begin,set s(v){s=v;},opp,get head(){return hd;}};
for(let k=0;k<30;k++)step(1/60);draw();requestAnimationFrame(loop);
}

