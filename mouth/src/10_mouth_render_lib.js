
{// ================= THE MOUTH — look development =================
const V={add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],mul:(a,s)=>[a[0]*s,a[1]*s,a[2]*s],dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
  cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],len:a=>Math.hypot(a[0],a[1],a[2]),norm:a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];},lerp:(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]};
const HX=h=>[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
// ---------- the flesh palette: wet black, raw red, pale marbled sinew, old bone, a throat that glows ----------
const R={black:['#040205','#0a050a','#120810','#1c0c17','#28121f','#36192a','#472337'].map(HX),
 red:['#0e0207','#1c040b','#300810','#480c18','#621320','#7e1c28','#9c2a30','#ba3e3c','#d45e50','#e8866a'].map(HX),
 pale:['#200e12','#3a1a1e','#5a2c2c','#7e443c','#a2604e','#c28268','#dca88c','#efcdb2','#fbe8d6'].map(HX),
 bone:['#160e0e','#2e201e','#4e3a34','#73594e','#9a7e70','#bfa392','#dbc6b4','#efe2d4','#fcf6ee'].map(HX),
 maw:['#080103','#170206','#2c040a','#4a080e','#701010','#9c1a12','#c82e16','#ee5420','#ff8a40'].map(HX)};
const BY=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5].map(v=>(v+.5)/16-.5);
const pick=(Rm,l,x,y)=>{let k=Math.floor(l*Rm.length+BY[(y&3)*4+(x&3)]*.7);return Rm[k<0?0:k>=Rm.length?Rm.length-1:k];};
// lights: the sun behind and to the right (the rim that makes wet flesh read), a key from the upper right, a cold violet fill from the left
const LK=V.norm([.5,-.62,.6]),LF=V.norm([-.85,.15,.35]),LB=V.norm([.75,-.25,-.6]);const HV=V.norm(V.add(LK,[0,0,1]));
// ---------- buffers ----------
let FB,EM,ZB;function clr(){FB=new Uint8ClampedArray(W*H*4);EM=new Uint8ClampedArray(W*H*4);ZB=new Float32Array(W*H).fill(-1e9);}
let CLIP=null,ZBIAS=0;function put(x,y,z,c,em){if(CLIP&&!CLIP(x,y))return;z+=ZBIAS;const i=y*W+x;if(z<=ZB[i])return;ZB[i]=z;const j=i*4;FB[j]=c[0];FB[j+1]=c[1];FB[j+2]=c[2];FB[j+3]=255;if(em){EM[j]=c[0];EM[j+1]=c[1];EM[j+2]=c[2];EM[j+3]=255;}else EM[j+3]=0;}
// ---------- shading wet flesh ----------
// n in screen space (x right, y down, z toward viewer)
// noise tables, computed once: the flesh pattern is looked up, not computed, per pixel
const NU=1024,NV=32;const TM=new Float32Array(NU*NV),TB=new Float32Array(NU*NV),TF=new Float32Array(NU*NV),TD=new Float32Array(NU*NV);
for(let j=0;j<NV;j++)for(let i=0;i<NU;i++){const u=i*1.0,v=j/(NV-1)*2-1;const k=j*NU+i;TM[k]=fbm(u*.007,v*.25,.3,3);TB[k]=1-Math.abs(2*fbm(u*.03,v*1.3+u*.01,.6,2)-1);TF[k]=n3(u*.025,v*2.2,.9);TD[k]=n3(u*.2,v*3,1.7);}
let WARM=false;const WOUNDS=[];function woundAt(sid,u){for(const w of WOUNDS)if(w.sid===sid&&Math.abs(u-w.u)<w.len)return 1-Math.abs(u-w.u)/w.len;return 0;}
function flesh(n,u,v,sid,x,y,deep){const ti=(((Math.floor(u+sid*137.3)%NU)+NU)%NU)+Math.min(NV-1,Math.max(0,Math.round((v+1)*.5*(NV-1))))*NU;const ny=-n[1];const nn=[n[0],ny,n[2]];
  const dif=Math.max(0,V.dot(nn,LK)),fil=Math.max(0,V.dot(nn,LF)),rim=Math.pow(Math.max(0,1-n[2]),2.8)*Math.max(0,V.dot([n[0],ny,0],[LB[0],LB[1],0])+.2);
  // wet: a sharp highlight, streaked along the strand by its fibres
  if(WOUNDS.length){const wd=woundAt(sid,u);if(wd>0){const raw=wd>.55&&Math.abs(v)<.6;return raw?(((x+y)&1)?[255,96,60]:[200,40,30]):[(90+wd*80)|0,10,14];}}
  const fibre=TF[ti];const spec=Math.pow(Math.max(0,V.dot(nn,HV)),36)*(.5+fibre*.8);
  // what the strand is made of: mostly wet black, raw red running through it, pale marbled sinew in places — long soft streaks
  const m=TM[ti]+(sid>=100?-.06:sid>=30&&sid<40?-.1:0)+(BY[(y&3)*4+(x&3)])*.08;
  const marble=TB[ti];
  let Rm=m<.53?R.black:m<.7?R.red:R.pale;let l=.02+.8*Math.pow(dif,1.15)+.08*fil-(deep||0)+(TD[ti]-.5)*.12;
  if(Rm===R.black&&marble>.94){Rm=R.red;l=l*.7+.06;}// red seeping through the black
  if(Rm===R.red&&marble>.965){Rm=R.pale;}// pale sinew threads in the red
  // folds: transverse wrinkles across the strand
  l+=Math.sin(u*.55+Math.sin(v*2)*1.5+sid)*.05;
  // the big coils are ropes of smaller strands: helical grooves and a highlight per sub-strand
  if(sid>=100){const st=Math.sin(Math.asin(Math.max(-1,Math.min(1,v)))*9+u*.11+sid);if(st>.9)l+=.16;else if(st<-.85)l*=.5;}
  let c=pick(Rm,l,x,y);
  if(!WARM&&fil>.5&&dif<.15)c=[(c[0]*.55+40*.45)|0,(c[1]*.55+26*.45)|0,(c[2]*.55+70*.45)|0];// cold violet in the shadows
  if(rim>.3)c=pick(R.red,.7+rim*.5,x,y);if(rim>.62)c=[255,170,150];// the sun through the edge of the flesh
  if(spec>.5)c=spec>.85?[255,244,240]:[226,160,162];
  return c;}
// ---------- tube raster: a capsule from p0 to p1, round in section, written into the depth buffer ----------
function tube(p0,p1,r0,r1,u0,u1,sid,deep,caps=3){const dx=p1[0]-p0[0],dy=p1[1]-p0[1];const L2=dx*dx+dy*dy||1e-6;const L=Math.sqrt(L2);const rmax=Math.max(r0,r1);
  const x0=Math.max(0,Math.floor(Math.min(p0[0],p1[0])-rmax-1)),x1=Math.min(W-1,Math.ceil(Math.max(p0[0],p1[0])+rmax+1)),y0=Math.max(0,Math.floor(Math.min(p0[1],p1[1])-rmax-1)),y1=Math.min(H-1,Math.ceil(Math.max(p0[1],p1[1])+rmax+1));
  const tx=dx/L,ty=dy/L;
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const px=x+.5-p0[0],py=y+.5-p0[1];let t=(px*dx+py*dy)/L2;if(t<0){if(!(caps&1)&&t<-.35)continue;t=(caps&1)?0:t;}if(t>1){if(!(caps&2)&&t>1.35)continue;t=(caps&2)?1:t;}const tt=t<0?0:t>1?1:t;const r=r0+(r1-r0)*tt;const cx=dx*t,cy=dy*t;const ex=px-cx,ey=py-cy;const d2=ex*ex+ey*ey;if(d2>r*r)continue;
    const nz=Math.sqrt(1-d2/(r*r));const z=p0[2]+(p1[2]-p0[2])*t+nz*r;const i=y*W+x;if(z<=ZB[i])continue;
    const side=(tx*ey-ty*ex)/r;const c=flesh([ex/r,ey/r,nz],u0+(u1-u0)*t,side,sid,x,y,deep);put(x,y,z,c,0);}}
// ---------- spines and barbs: bone hooks raking backward off the strands ----------
function barb(p,dir,len,w,x0){const bend=[-dir[1]*.35,dir[0]*.35,0];const n=Math.max(2,Math.round(len));for(let k=0;k<n;k++){const f=k/n;const q=[p[0]+dir[0]*len*f+bend[0]*len*f*f,p[1]+dir[1]*len*f+bend[1]*len*f*f,p[2]+dir[2]*len*f+2];const ww=Math.max(.5,w*(1-f));
  for(let a=-Math.ceil(ww);a<=Math.ceil(ww);a++){const X=Math.round(q[0]-dir[1]*a),Y=Math.round(q[1]+dir[0]*a);if(X<0||Y<0||X>=W||Y>=H)continue;const lit=a<0?.45:.22;put(X,Y,q[2],pick(f<.4?R.red:R.bone,lit+f*.32,X,Y),0);}}}
// ---------- splines ----------
function catmull(P,t){const n=P.length-1;const s=Math.min(n-1e-6,Math.max(0,t*n));const i=Math.floor(s),f=s-i;const p0=P[Math.max(0,i-1)],p1=P[i],p2=P[i+1],p3=P[Math.min(n,i+2)];
  return[0,1,2].map(k=>.5*((2*p1[k])+(-p0[k]+p2[k])*f+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*f*f+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*f*f*f));}
function sampleSpine(P,step){const pts=[];let prev=catmull(P,0);pts.push({p:prev,s:0});let s=0;for(let i=1;i<=600;i++){const q=catmull(P,i/600);const d=Math.hypot(q[0]-prev[0],q[1]-prev[1]);s+=d;if(s-pts[pts.length-1].s>=step||i===600)pts.push({p:q,s});prev=q;}
  for(let i=0;i<pts.length;i++){const a=pts[Math.max(0,i-1)].p,b=pts[Math.min(pts.length-1,i+1)].p;const tx=b[0]-a[0],ty=b[1]-a[1];const l=Math.hypot(tx,ty)||1;pts[i].t=[tx/l,ty/l];pts[i].n=[-ty/l,tx/l];}return pts;}
// ---------- strands as paths: a braid gives paths; a path can be drawn, or braided again from thinner strands ----------
function braidPaths(P,o,t){const sp=Array.isArray(P[0])?sampleSpine(P,o.step||3):P;const N=o.n;const total=sp[sp.length-1].s||1;const out=[];
  for(let k=0;k<N;k++){const ph0=k/N*TAU+(o.phase||0);const path=[];
    for(let i=0;i<sp.length;i++){const S=sp[i];const f=S.s/total;const BR=o.br(f,S),SR=o.sr(f,k,S);const ph=ph0+S.s*o.twist+t*(o.writhe||0)+Math.sin(S.s*.02+k+t*.7)*.25;
      const wob=(n3(S.s*.03,k*3.1+(o.sid||0),t*.4)-.5)*o.wob;const off=BR+wob;const zb=S.z||[0,0,1];
      // the strand sits on a circle round the spine: screen-normal × cos, depth × sin
      const pos=[S.p[0]+S.n[0]*Math.cos(ph)*off,S.p[1]+S.n[1]*Math.cos(ph)*off,S.p[2]+Math.sin(ph)*off];path.push({p:pos,r:SR,s:S.s,c:Math.cos(ph),f});}
    // tangent and screen-normal of the strand itself, for braiding it again
    for(let i=0;i<path.length;i++){const A=path[Math.max(0,i-1)].p,B=path[Math.min(path.length-1,i+1)].p;const tx=B[0]-A[0],ty=B[1]-A[1];const l=Math.hypot(tx,ty)||1;path[i].t=[tx/l,ty/l];path[i].n=[-ty/l,tx/l];path[i].p0=path[i].p;}
    out.push(path);}return out;}
function drawPath(path,sid,deep,o={}){for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i];if(b.r<.4)continue;tube(a.p,b.p,a.r,b.r,a.s,b.s,sid,typeof deep==='function'?deep(b.f):deep||0,(i===1?1:0)|(i===path.length-1?2:0));
  if(o.barbs&&i%o.barbs===sid%o.barbs&&b.f>.08&&b.f<.94&&b.r>1.6){const side=Math.sign(b.c)||1;const d=V.norm([b.n[0]*side*.9-b.t[0]*.6,b.n[1]*side*.9-b.t[1]*.6,.15]);barb([b.p[0]+b.n[0]*side*b.r,b.p[1]+b.n[1]*side*b.r,b.p[2]],d,b.r*.8+2+h3(i,sid,3)*5,1.2,0);}}}
// a path re-sampled as a spine for a sub-braid
function asSpine(path){let s=0;return path.map((q,i)=>{if(i)s+=Math.hypot(q.p[0]-path[i-1].p[0],q.p[1]-path[i-1].p[1]);return{p:q.p,s,t:q.t,n:q.n,r:q.r};});}
// ---------- slime: threads of mucus stretched between surfaces, sagging, beaded ----------
const SLIME=[];function slime(p0,p1,sag,t,seed){const n=Math.max(4,Math.ceil(Math.hypot(p1[0]-p0[0],p1[1]-p0[1])));const thick=h3(seed,1,2)>.7?2:1;
  for(let k=0;k<=n;k++){const f=k/n;const sw=Math.sin(Math.PI*f);const q=V.lerp(p0,p1,f);const X=Math.round(q[0]+Math.sin(t*1.3+seed+f*3)*sw*2),Y=Math.round(q[1]+sag*sw+Math.cos(t+seed)*sw*1.5);if(X<0||Y<0||X>=W||Y>=H)continue;
    const glint=((k+Math.floor(t*6)+seed)%11)===0;const c=glint?[255,236,236]:f<.12||f>.88?[150,60,70]:[214,150,156];put(X,Y,q[2]+3,c,glint?1:0);if(thick>1&&f>.1&&f<.9)put(X,Y+1,q[2]+3,[120,50,60],0);
    // beads gather where the thread sags most
    if(Math.abs(f-.5)<.04&&h3(seed,3,4)>.5){for(let dy=1;dy<=2;dy++)put(X,Y+dy,q[2]+3,dy===2?[255,220,220]:[190,110,118],0);}}}
// ---------- the head: a funnel of flesh opening into a throat of claws, inside an armillary of jaw-rings ----------
function basis(a){let u=V.cross(a,[0,0,1]);if(V.len(u)<.1)u=V.cross(a,[0,1,0]);u=V.norm(u);const w=V.norm(V.cross(a,u));return[u,w];}
function annulus(c,a,u,w,r0,r1,shade){const ext=r1+2;const x0=Math.max(0,Math.floor(c[0]-ext)),x1=Math.min(W-1,Math.ceil(c[0]+ext)),y0=Math.max(0,Math.floor(c[1]-ext)),y1=Math.min(H-1,Math.ceil(c[1]+ext));
  const det=u[0]*w[1]-u[1]*w[0];if(Math.abs(det)<.05)return;
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const px=x+.5-c[0],py=y+.5-c[1];const s_=(px*w[1]-py*w[0])/det,q=(u[0]*py-u[1]*px)/det;const r=Math.hypot(s_,q);if(r<r0||r>r1)continue;const z=c[2]+s_*u[2]+q*w[2];const ang=Math.atan2(q,s_);const res=shade(r,ang,x,y);if(res)put(x,y,z+(res[2]||0),res[0],res[1]);}}
function tooth(base,tip,w){const n=Math.max(2,Math.ceil(Math.hypot(tip[0]-base[0],tip[1]-base[1])));const dx=(tip[0]-base[0]),dy=(tip[1]-base[1]);const l=Math.hypot(dx,dy)||1;const px=-dy/l,py=dx/l;
  for(let k=0;k<=n;k++){const f=k/n;const q=V.lerp(base,tip,f);const ww=w*(1-f*.85);for(let a=-Math.ceil(ww);a<=Math.ceil(ww);a++){if(Math.abs(a)>ww+.3)continue;const X=Math.round(q[0]+px*a),Y=Math.round(q[1]+py*a);if(X<0||Y<0||X>=W||Y>=H)continue;
    const l2=a<=0?.82-f*.12:.48-f*.08;put(X,Y,q[2]+(1-f)*1.5,pick(R.bone,l2,X,Y),0);}}}
// a claw: a broad root in a wet gum, curving forward to a point
function claw(base,dirIn,fwd,len,w,gum=true){const mid=V.add(base,V.add(V.mul(dirIn,len*.55),V.mul(fwd,len*.12)));const tip=V.add(mid,V.add(V.mul(dirIn,len*.22),V.mul(fwd,len*.5)));
  if(gum){for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){if(dx*dx+dy*dy>4.5)continue;const X=Math.round(base[0]+dx),Y=Math.round(base[1]+dy);if(X<0||Y<0||X>=W||Y>=H)continue;put(X,Y,base[2]+1,dy<0?pick(R.red,.55,X,Y):pick(R.red,.25,X,Y),0);}}
  tooth(base,mid,w);tooth(mid,tip,w*.62);return tip;}
function head(C,a,Rh,t,o={}){a=V.norm(a);let[u,w]=basis(a);const tips=[];
  // the whole head rolls about its own axis — slowly at rest, wrenching in the wind-up
  if(o.roll){const cr=Math.cos(o.roll),sr=Math.sin(o.roll);const u2=V.add(V.mul(u,cr),V.mul(w,sr)),w2=V.sub(V.mul(w,cr),V.mul(u,sr));u=u2;w=w2;}
  Rh=Rh*(1+(o.pulse||0));const BRK=o.broken||null,RHP=o.ringHp||null,GAPS=o.ringGaps||null;const gape=o.gape||1,spread=o.spread||0,jit=o.jit||0,grind=o.grind||0;
  // the funnel: the neck flaring into the mouth; the neck's strands run on as ridges in its flesh
  const HL=o.len||1.9;const B=V.sub(C,V.mul(a,Rh*HL)),Rn=o.neckR||24;const NF=Math.ceil(Rh*HL/1.5);
  // (fast) the funnel as a few tapered tube segments along the head axis, ribbed, flaring
  const NS=7;let prevP=B,prevR=Rn;for(let k=1;k<=NS;k++){const f=k/NS;const ribs=1+.06*Math.max(0,Math.sin(f*13-t*1.4));const rk=(Rn+(Rh*.96-Rn)*Math.pow(f,1.25))*ribs;const ck=V.lerp(B,C,f*.97);
    WARM=true;tube(prevP,ck,prevR,rk,(k-1)*14,k*14,94+k,-.08,(k===1?1:0));WARM=false;prevP=ck;prevR=rk;}
  // the mouth opening: whatever is inside it is seen through the hollow funnel
  const det0=u[0]*w[1]-u[1]*w[0];const RO=Rh*.74*Math.min(1.25,gape);const inOpen=(x,y)=>{if(Math.abs(det0)<.05)return true;const px=x+.5-C[0],py=y+.5-C[1];const s_=(px*w[1]-py*w[0])/det0,q=(u[0]*py-u[1]*px)/det0;return s_*s_+q*q<RO*RO;};
  CLIP=inOpen;ZBIAS=Rh*3;
  // the throat: a gullet of wet rings, curved claws round each, a red glow at the bottom
  const D=5;for(let k=D;k>=0;k--){const ck=V.sub(C,V.mul(a,k*Rh*.22+Rh*.05));const rk=Rh*(.7-k*.1);const rn=k<D?Rh*(.7-(k+1)*.1):0;
    annulus(ck,a,u,w,rn*.85,rk*1.05,(r,ang,x,y)=>{const f=(r-rn)/(rk-rn+1e-6);const fold=Math.sin(ang*8+k*1.3+Math.sin(ang*3+t*.7)*1.6);
      if(k===D){const g=1-r/rk;return[pick(R.maw,.45+.7*g+Math.sin(t*2.6)*.06,x,y),1];}
      const l=.03+.16*(1-k/D)+fold*.06+Math.pow(f,3)*.34;const wet=fold>.86&&f>.55;return[wet?[220,110,110]:pick(k>=2?R.maw:R.red,l,x,y),0];});
    const nt=Math.round(11-k*1.2);for(let j=0;j<nt;j++){const th=j/nt*TAU+k*.41+Math.sin(t*.8+k)*.05;const dir=V.add(V.mul(u,Math.cos(th)),V.mul(w,Math.sin(th)));const base=V.add(ck,V.mul(dir,rk*.98));
      const len=rk*(.36+.2*h3(j,k,9))*(o.open||1);if(BRK&&BRK.has('t'+k+'_'+j)){claw(base,V.mul(dir,-1),a,len*.25,3.4-k*.45,k<3);continue;}const tp=claw(base,V.mul(dir,-1),a,len,3.4-k*.45,k<3);if(k<=1)tips.push(tp);}}
  CLIP=null;ZBIAS=0;
  // lips: a thick collar of folded flesh, gums and a rim of claws
  annulus(C,a,u,w,Rh*.7*Math.min(1.25,gape),Rh*(1.08+.18*Math.max(0,gape-1)),(r,ang,x,y)=>{const f=(r-Rh*.7*Math.min(1.25,gape))/(Rh*(.38+.18*Math.max(0,gape-1)));const fold=Math.sin(ang*19+Math.sin(ang*3+t*.4)*2);const rad=V.add(V.mul(u,Math.cos(ang)),V.mul(w,Math.sin(ang)));
    const nr=V.norm(V.add(V.mul(rad,(f-.45)*1.6),V.mul(a,.75)));return[fold>.7&&f<.4?pick(R.pale,.62,x,y):flesh(nr,ang*30+fold*3,f*2-1,91,x,y,-.04),0,Math.sin(f*Math.PI)*4];});
  for(let j=0;j<30;j++){const th=j/30*TAU+.1;const dir=V.add(V.mul(u,Math.cos(th)),V.mul(w,Math.sin(th)));const base=V.add(C,V.add(V.mul(dir,Rh*.97),V.mul(a,3)));claw(base,V.add(V.mul(dir,.35),V.mul(a,.2)),a,Rh*(.16+.1*h3(j,2,4)),2.4);}
  // saliva stretched across the open throat, tooth to tooth
  CLIP=inOpen;ZBIAS=Rh*3.2;for(let k=0;k<6;k++){const i0=(k*5+1)%tips.length,i1=(k*5+Math.floor(tips.length/2)+k)%tips.length;if(tips[i0]&&tips[i1])slime(tips[i0],tips[i1],6+h3(k,1,1)*10,t,k*7+1);}CLIP=null;ZBIAS=0;
  // the armillary: jaw-rings that are not circles — wobbling, swelling, ribbed, clawed
  const RG=o.rings||[{R:1.12,tilt:.55,g0:0,w:.22,spin:.3,off:.12,ell:.14},{R:1.3,tilt:.95,g0:2.1,w:-.16,spin:-.24,off:-.25,ell:-.2},{R:1.06,tilt:1.25,g0:4.0,w:.3,spin:.42,off:.3,ell:.16},{R:1.22,tilt:.75,g0:5.3,w:-.12,spin:.2,off:-.6,ell:.22}];
  RG.forEach((g,gi)=>{if(RHP&&RHP[gi]<=0)return;const ST_=(o.spinT!==undefined?o.spinT:t)*(grind&&gi%2?-1-2*grind:1)+jit*.35*Math.sin(t*23+gi*7.1)*Math.max(0,Math.sin(t*3.1+gi*2.3));const gam=g.g0+ST_*g.w;const tl=g.tilt+spread*.35*(gi%2?1:-1);const nrm=V.norm(V.add(V.mul(a,Math.cos(tl)),V.add(V.mul(u,Math.sin(tl)*Math.cos(gam)),V.mul(w,Math.sin(tl)*Math.sin(gam)))));const[e1,e2]=basis(nrm);
    const cc=V.add(V.add(C,V.mul(a,Rh*(g.off+spread*.35*(gi%2?.6:1)))),V.add(V.mul(u,Math.sin(gi*2.1)*Rh*.08),V.mul(w,Math.cos(gi*1.7)*Rh*.06)));
    const R0=Rh*g.R*(o.rs||1)*(1+.16*spread);const steps=Math.ceil(TAU*R0*1.15/1.5);
    for(let j=0;j<steps;j++){if(GAPS&&GAPS[gi]){const fr=j/steps;let gap=false;for(const q of GAPS[gi])if(Math.abs(((fr-q[0]+1.5)%1)-.5)<q[1]){gap=true;break;}if(gap)continue;}const th=j/steps*TAU+ST_*g.spin;const rr=R0*(1+g.ell*Math.cos(2*th)+.07*(n3(th*1.4,gi*3,t*.15)-.5)*2);const dir=V.add(V.mul(e1,Math.cos(th)),V.mul(e2,Math.sin(th)));const p=V.add(cc,V.mul(dir,rr));const X=Math.round(p[0]),Y=Math.round(p[1]);
      // swelling ribs along the band; bone lit toward the sun, flesh where it joins the claws
      const rib=.5+.5*Math.sin(j/steps*TAU*rr/6);const hw=2.4+1.6*rib+1.2*Math.max(0,Math.sin(th*2+gi));const lit=Math.max(0,V.dot([dir[0],-dir[1],dir[2]],LK))*.55+.22+(dir[2]>0?.12:-.08);
      const hc=Math.ceil(hw);for(let dy=-hc;dy<=hc;dy++)for(let dx=-hc;dx<=hc;dx++){const hd=Math.hypot(dx,dy);if(hd>hw)continue;const XX=X+dx,YY=Y+dy;if(XX<0||YY<0||XX>=W||YY>=H)continue;
        put(XX,YY,p[2]+(hw-hd),hd>hw-.8&&rib<.35?pick(R.red,.3,XX,YY):pick(R.bone,lit+(dy<0?.14:-.06)-hd*.05+rib*.08,XX,YY),0);}
      if(j%4===0&&!(BRK&&BRK.has('r'+gi+'_'+j))){const ln=Rh*(.1+.08*h3(j,gi,1));claw(V.add(p,V.mul(dir,-hw+.5)),V.norm(V.add(V.mul(dir,-1),V.mul(nrm,.2))),V.mul(nrm,.6),ln,2.4,true);}
      if(j%35===11){const ln=Rh*(.14+.08*h3(j,gi,7));claw(p,dir,nrm,ln,1.6,false);}
      // threads of slime from the ring back to the lips
      if(j===Math.floor(steps*(.2+gi*.27))){const lp=V.add(C,V.mul(V.norm(V.sub(p,C)),Rh*.95));slime(p,lp,14+gi*5,t,gi*31+j);}}});
  return{u,w,B};}
// ---------- asteroids: dark lumps with a sun-lit rim, for scale and depth ----------
function rock(cx,cy,r,z,seed){for(let y=Math.floor(cy-r*1.3);y<=cy+r*1.3;y++)for(let x=Math.floor(cx-r*1.3);x<=cx+r*1.3;x++){if(x<0||y<0||x>=W||y>=H)continue;const dx=(x-cx)/r,dy=(y-cy)/r;const a=Math.atan2(dy,dx);const rr=1+.25*(n3(Math.cos(a)*2+seed,Math.sin(a)*2,seed)-.5)*2;const d=Math.hypot(dx,dy)/rr;if(d>1)continue;
  const nz=Math.sqrt(1-d*d);const l=Math.max(0,dx*.55-dy*.6+nz*.5)*.6+.05+(n3(x*.3,y*.3,seed)-.5)*.15;const rim=d>.8&&dx>.2;put(x,y,z+nz*r,rim?[200,170,170]:pick(R.black,l*1.4,x,y),0);}}
