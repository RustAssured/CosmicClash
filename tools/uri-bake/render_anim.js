// 우리 — a real 3D render (SDF raymarching) to be quantized into pixel art
const fs=require('fs');
const W=+process.argv[2]||640,H=+process.argv[3]||360,VARIANT=process.argv[5]||"hero",CAM=process.argv[6]||"hero";
const clamp=(v,a,b)=>v<a?a:v>b?b:v,mix=(a,b,t)=>a+(b-a)*t,sst=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
function h3(x,y,z){let h=Math.imul(x|0,374761393)+Math.imul(y|0,668265263)+Math.imul(z|0,1274126177)|0;h=Math.imul(h^(h>>>13),1274126177);return((h^(h>>>16))>>>0)/4294967295;}
function n3(x,y,z){const xi=Math.floor(x),yi=Math.floor(y),zi=Math.floor(z);const xf=x-xi,yf=y-yi,zf=z-zi;const u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf),w=zf*zf*(3-2*zf);
  const a=mix(mix(h3(xi,yi,zi),h3(xi+1,yi,zi),u),mix(h3(xi,yi+1,zi),h3(xi+1,yi+1,zi),u),v),b=mix(mix(h3(xi,yi,zi+1),h3(xi+1,yi,zi+1),u),mix(h3(xi,yi+1,zi+1),h3(xi+1,yi+1,zi+1),u),v);return mix(a,b,w);}
function fbm(x,y,z,o){let s=0,a=.5,f=1,n=0;for(let i=0;i<o;i++){s+=a*n3(x*f,y*f,z*f);n+=a;a*=.5;f*=2.07;}return s/n;}
function cell3(x,y,z){const xi=Math.floor(x),yi=Math.floor(y),zi=Math.floor(z);let d1=9,d2=9,id=0;for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++)for(let k=-1;k<=1;k++){const cx=xi+i,cy=yi+j,cz=zi+k;const px=cx+h3(cx,cy,cz),py=cy+h3(cx,cz,cy),pz=cz+h3(cz,cy,cx);const d=(x-px)**2+(y-py)**2+(z-pz)**2;if(d<d1){d2=d1;d1=d;id=h3(cx+7,cy+3,cz+1);}else if(d<d2)d2=d;}return[Math.sqrt(d2)-Math.sqrt(d1),id];}
const smin=(a,b,k)=>{const h=clamp(.5+.5*(b-a)/k,0,1);return mix(b,a,h)-k*h*(1-h);};
function capsule(px,py,pz,ax,ay,az,bx,by,bz,r){const pax=px-ax,pay=py-ay,paz=pz-az,bax=bx-ax,bay=by-ay,baz=bz-az;const h=clamp((pax*bax+pay*bay+paz*baz)/(bax*bax+bay*bay+baz*baz),0,1);const dx=pax-bax*h,dy=pay-bay*h,dz=paz-baz*h;return Math.sqrt(dx*dx+dy*dy+dz*dz)-r;}
function rcone(px,py,pz,ax,ay,az,bx,by,bz,r1,r2){const pax=px-ax,pay=py-ay,paz=pz-az,bax=bx-ax,bay=by-ay,baz=bz-az;const L2=bax*bax+bay*bay+baz*baz;const h=clamp((pax*bax+pay*bay+paz*baz)/L2,0,1);const dx=pax-bax*h,dy=pay-bay*h,dz=paz-baz*h;return Math.sqrt(dx*dx+dy*dy+dz*dz)-mix(r1,r2,h);}
function torus(px,py,pz,cx,cy,cz,nx,ny,nz,R,r){const qx=px-cx,qy=py-cy,qz=pz-cz;const h=qx*nx+qy*ny+qz*nz;const rx=qx-nx*h,ry=qy-ny*h,rz=qz-nz*h;const rad=Math.sqrt(rx*rx+ry*ry+rz*rz)-R;return Math.sqrt(rad*rad+h*h)-r;}
function ellip(px,py,pz,cx,cy,cz,rx,ry,rz){const x=(px-cx)/rx,y=(py-cy)/ry,z=(pz-cz)/rz;const k0=Math.sqrt(x*x+y*y+z*z);const k1=Math.sqrt(x*x/(rx*rx)+y*y/(ry*ry)+z*z/(rz*rz));return k0*(k0-1)/k1;}
function rbox(lx,ly,lz,bx,by,bz,r){const qx=Math.abs(lx)-bx+r,qy=Math.abs(ly)-by+r,qz=Math.abs(lz)-bz+r;return Math.sqrt(Math.max(qx,0)**2+Math.max(qy,0)**2+Math.max(qz,0)**2)+Math.min(Math.max(qx,Math.max(qy,qz)),0)-r;}
function norm(x,y,z){const l=Math.hypot(x,y,z);return[x/l,y/l,z/l];}
function cross(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}

// ================= 우리 in motion: pose system, local texturing, toon shading =================
const FRAME=+process.argv[8]||0,NF=+process.argv[9]||1,MODE=process.argv[10]||'toon';const TN=FRAME/NF;
const add3=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],sub3=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],sc3=(a,s)=>[a[0]*s,a[1]*s,a[2]*s],lerp3=(a,b,f)=>[mix(a[0],b[0],f),mix(a[1],b[1],f),mix(a[2],b[2],f)];
const rotY=(p,a)=>{const c=Math.cos(a),s=Math.sin(a);return[p[0]*c+p[2]*s,p[1],-p[0]*s+p[2]*c];};
// ---------- the punch, as keyframes: idle, wind-up, strike, overshoot, settle ----------
const BASE={eR:[5.3,1.4,0.6],wR:[7.0,0.1,1.9],eL:[-5.0,1.0,2.0],wL:[-3.7,1.0,4.4]};
const KEYS=[
 {t:0,   th:0,    cr:0,   eR:BASE.eR,           wR:BASE.wR,           eL:BASE.eL,          wL:BASE.wL,          fl:1,   en:.4},
 {t:.14, th:.03,  cr:.05, eR:[5.25,1.45,0.55],  wR:[6.9,0.2,1.8],     eL:BASE.eL,          wL:BASE.wL,          fl:1,   en:.5},
 {t:.42, th:.4,   cr:.45, eR:[4.9,0.9,-1.7],    wR:[5.6,2.4,-1.2],    eL:[-4.9,1.3,2.4],   wL:[-3.4,1.8,4.6],   fl:1.6, en:1.6},
 {t:.52, th:-.3,  cr:.15, eR:[6.2,2.0,1.1],     wR:[8.9,1.6,2.7],     eL:[-5.3,0.6,0.6],   wL:[-4.6,0.2,2.6],   fl:2.6, en:1.2},
 {t:.62, th:-.38, cr:.05, eR:[6.3,2.0,1.3],     wR:[9.1,1.5,3.0],     eL:[-5.3,0.5,0.4],   wL:[-4.7,0.1,2.4],   fl:1.8, en:.9},
 {t:.82, th:-.08, cr:.02, eR:[5.6,1.6,0.8],     wR:[7.6,0.4,2.2],     eL:[-5.1,0.9,1.7],   wL:[-3.9,0.8,4.1],   fl:1.1, en:.5},
 {t:1,   th:0,    cr:0,   eR:BASE.eR,           wR:BASE.wR,           eL:BASE.eL,          wL:BASE.wL,          fl:1,   en:.4}];
function pose(tn){let a=KEYS[0],b=KEYS[KEYS.length-1];for(let i=0;i<KEYS.length-1;i++)if(tn>=KEYS[i].t&&tn<=KEYS[i+1].t){a=KEYS[i];b=KEYS[i+1];break;}
  const u=(tn-a.t)/((b.t-a.t)||1);const e=u*u*(3-2*u);const P={};for(const k of['th','cr','fl','en'])P[k]=mix(a[k],b[k],e);for(const k of['eR','wR','eL','wL'])P[k]=lerp3(a[k],b[k],e);return P;}
const PZ=pose(TN);const PIV=[0,1.0,0];
const toLocal=p=>{const q=rotY(sub3(p,PIV),-PZ.th);return[q[0]+PIV[0],q[1]+PIV[1]+PZ.cr,q[2]+PIV[2]];};
const toWorld=p=>{const q=rotY(sub3([p[0],p[1]-PZ.cr,p[2]],PIV),PZ.th);return add3(q,PIV);};
// joints: shoulders ride the torso; elbows and wrists come from the keyframes
const J={head:[0.25,5.25,0.85],hR:1.45};const sLl=[-3.55,3.0,0.35],sRl=[3.55,3.0,0.0];
J.sL=toWorld(sLl);J.sR=toWorld(sRl);J.eL=PZ.eL;J.wL=PZ.wL;J.eR=PZ.eR;J.wR=PZ.wR;
J.hipL=[-1.45,-1.2,0.1];J.kL=[-1.9,-3.0,0.8];J.aL=[-2.05,-4.55,0.7];J.hipR=[1.45,-1.2,-0.1];J.kR=[2.0,-2.95,-0.35];J.aR=[2.3,-4.45,-0.3];
function fistFrame(e,w,up){const d=norm(w[0]-e[0],w[1]-e[1],w[2]-e[2]);let z=norm(...cross(d,up));let y=cross(z,d);return{d,y,z,c:[w[0]+d[0]*1.05,w[1]+d[1]*1.05,w[2]+d[2]*1.05]};}
const FL=fistFrame(J.eL,J.wL,[0.2,1,0]),FR=fistFrame(J.eR,J.wR,[0,1,0.3]);const S=1.35;
function fist(px,py,pz,F){const qx=px-F.c[0],qy=py-F.c[1],qz=pz-F.c[2];const lx=(qx*F.d[0]+qy*F.d[1]+qz*F.d[2])/S,ly=(qx*F.y[0]+qy*F.y[1]+qz*F.y[2])/S,lz=(qx*F.z[0]+qy*F.z[1]+qz*F.z[2])/S;
  if(lx*lx+ly*ly+lz*lz>4.5)return Math.sqrt(lx*lx+ly*ly+lz*lz)*S-1.9;
  let d=rbox(lx+.05,ly,lz,.5,.55,.68,.22);
  for(const z of[-.48,-.16,.16,.48]){const k=Math.abs(z)>.3?.92:1;let f=capsule(lx,ly,lz,.35,.42*k,z,.92*k,.36*k,z,.21);f=Math.min(f,capsule(lx,ly,lz,.92*k,.36*k,z,.98*k,-.12,z,.2));f=Math.min(f,capsule(lx,ly,lz,.98*k,-.12,z,.62,-.36,z,.18));
    const kn=Math.sqrt((lx-.9*k)**2+(ly-.42*k)**2+(lz-z)**2)-.25;f=smin(f,kn,.06);d=smin(d,f,.05);}
  d=smin(d,capsule(lx,ly,lz,.05,-.5,.72,.7,-.58,.18,.2),.08);return d*S;}
function cityMap(px,py,pz,cx,cz,top,gold){const dx=px-cx,dz=pz-cz;const r=Math.hypot(dx,dz);if(r>1.75||py>top+3.4||py<top-.05)return 9;
  const cs=.17;const ix=Math.floor(dx/cs),iz=Math.floor(dz/cs);let best=9;
  for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++){const cxx=(ix+a+.5)*cs,czz=(iz+b+.5)*cs;const rr=Math.hypot(cxx,czz);if(rr>1.45)continue;const hh=h3(ix+a,iz+b,gold?3:4);if(hh<.25)continue;
    const ht=(.3+hh*1.5)*(1.25-rr/1.6)+(rr<.6&&hh>.6?1.3:0);const lx=dx-cxx,lz=dz-czz,ly=py-top;const w=(gold?.07:.055)*(1-clamp(ly/ht,0,1)*.85)+.01;
    const dd=Math.max(Math.hypot(lx,lz)-w,ly-ht,-ly);if(dd<best)best=dd;}return best;}
// segments with their own frames, so the stone pattern rides on the limb instead of swimming
const SEGS=[];function seg(id,a,b,r1,r2){const d=norm(...sub3(b,a));let e1=cross(d,[0,0,1]);if(Math.hypot(...e1)<.1)e1=cross(d,[1,0,0]);e1=norm(...e1);const e2=cross(d,e1);SEGS[id]={a,b,r1,r2,d,e1,e2};}
seg(10,J.sL,J.eL,1.05,.95);seg(11,J.eL,J.wL,1.25,1.15);seg(13,J.sR,J.eR,1.05,.95);seg(14,J.eR,J.wR,1.25,1.15);
seg(20,J.hipL,J.kL,1.25,1.1);seg(21,J.kL,J.aL,1.1,1.25);seg(22,J.hipR,J.kR,1.25,1.1);seg(23,J.kR,J.aR,1.1,1.25);
let MAT=0,PART=0;
function map(px,py,pz){let d,m,pt;
  const L=toLocal([px,py,pz]);const lx=L[0],ly=L[1],lz=L[2];
  // upper body in its own (rotating) space
  let t=ellip(lx,ly,lz,0,2.0,0,3.0,2.75,2.3);
  t=smin(t,Math.sqrt((lx-sLl[0]+.45)**2+(ly-3.55)**2+(lz-sLl[2])**2)-1.85,.7);t=smin(t,Math.sqrt((lx-sRl[0]+.45)**2+(ly-3.5)**2+(lz-sRl[2])**2)-1.8,.7);
  t=Math.max(t,ly-4.55-(Math.abs(lx)<1.1?.6:0));t=smin(t,ellip(lx,ly,lz,0,2.5,.7,2.2,1.7,1.55),.5);
  // the bronze collar where the head sits
  const col=torus(lx,ly,lz,0,4.15,.35,0,1,.15,1.35,.2);
  d=t;m=1;pt=0;if(col<d){d=col;m=2;}
  // a heavy helmet: a broad dome cut flat, a brow ridge, cheek guards, a low crest
  const hx=lx-J.head[0],hy=ly-J.head[1],hz=lz-J.head[2];
  let H_=smin(Math.sqrt(hx*hx+hy*hy*1.25+hz*hz)-J.hR,rbox(hx,hy+.35,hz,1.05,.75,1.0,.45),.3);H_=Math.max(H_,hy-1.0);
  H_=smin(H_,rbox(hx,hy-.38,hz-.95,1.05,.14,.32,.08),.12);
  H_=smin(H_,rbox(Math.abs(hx)-.95,hy+.45,hz-.3,.22,.55,.7,.12),.15);
  H_=smin(H_,rbox(hx,hy-1.0,hz+.1,.13,.12,.9,.06),.1);
  H_=Math.max(H_,-rbox(hx,hy-.02,hz-1.2,.85,.12,.45,.03));
  H_=smin(H_,capsule(lx,ly,lz,0,4.0,.2,J.head[0],J.head[1]-.6,J.head[2]-.2,.95),.3);
  if(H_<d+.01){d=smin(d,H_,.15);if(H_<t&&H_<col)m=5;}
  // cities ride the shoulders
  const cg=cityMap(lx,ly,lz,sLl[0]-.45,sLl[2],4.55,true);if(cg<d){d=cg;m=8;}const cc=cityMap(lx,ly,lz,sRl[0]-.45,sRl[2],4.55,false);if(cc<d){d=cc;m=9;}
  // waist and pelvis stay with the legs: the torso twists against them
  const waist=Math.max(Math.hypot(px,pz*1.1)-1.75,Math.abs(py+0.35)-.45);if(waist<d){d=smin(d,waist,.25);if(waist<.02){m=2;pt=1;}}
  const pel=rbox(px,py+1.15,pz-.05,1.75,.6,1.25,.4);if(pel<d){d=smin(d,pel,.3);if(pel<.02){m=1;pt=1;}}
  for(const id of[10,11,13,14,20,21,22,23]){const s=SEGS[id];const v=rcone(px,py,pz,s.a[0],s.a[1],s.a[2],s.b[0],s.b[1],s.b[2],s.r1,s.r2);if(v<d){d=v;m=1;pt=id;}}
  const fL=fist(px,py,pz,FL);if(fL<d){d=fL;m=1;pt=12;}const fR=fist(px,py,pz,FR);if(fR<d){d=fR;m=1;pt=15;}
  for(const[an]of[[J.aL],[J.aR]]){const pod=smin(ellip(px,py,pz,an[0],an[1]-.6,an[2],1.55,.62,1.55),rcone(px,py,pz,an[0],an[1]+.2,an[2],an[0],an[1]-.4,an[2],1.0,1.3),.2);if(pod<d){d=pod;m=10;pt=1;}}
  const ring=(c,a,b,R,rr,mat)=>{const dc=Math.hypot(px-c[0],py-c[1],pz-c[2])-R-rr;if(dc>d)return;const n=norm(...sub3(b,a));const v=torus(px,py,pz,c[0],c[1],c[2],n[0],n[1],n[2],R,rr);if(v<d){d=v;m=mat;pt=1;}};
  for(const id of[10,11,13,14,20,21,22,23]){const s=SEGS[id];ring(lerp3(s.a,s.b,.84),s.a,s.b,(s.r1+s.r2)/2*.97,.09,2);}
  for(const[a,b,r]of[[J.sL,J.eL,1.05],[J.eL,J.wL,1.1],[J.wL,FL.c,1.0],[J.sR,J.eR,1.05],[J.eR,J.wR,1.1],[J.wR,FR.c,1.0],[J.hipL,J.kL,1.1],[J.kL,J.aL,1.08],[J.hipR,J.kR,1.1],[J.kR,J.aR,1.08]]){ring(a,a,b,r*1.08,.1,4);ring(add3(a,sc3(sub3(b,a),.06)),a,b,r*1.12,.07,4);}
  if((m===1||m===5)&&d<.35){const q=localOf(pt,px,py,pz,L);d+=(fbm(q[0]*1.7,q[1]*1.7,q[2]*1.7,3)-.5)*(m===5?.05:.16);}
  MAT=m;PART=pt;return d;}
function localOf(pt,px,py,pz,L){if(pt===0)return L;if(pt===1)return[px,py,pz];
  if(pt===12||pt===15){const F=pt===12?FL:FR;const q=[px-F.c[0],py-F.c[1],pz-F.c[2]];return[(q[0]*F.d[0]+q[1]*F.d[1]+q[2]*F.d[2])+pt,(q[0]*F.y[0]+q[1]*F.y[1]+q[2]*F.y[2]),(q[0]*F.z[0]+q[1]*F.z[1]+q[2]*F.z[2])];}
  const s=SEGS[pt];const q=[px-s.a[0],py-s.a[1],pz-s.a[2]];return[(q[0]*s.d[0]+q[1]*s.d[1]+q[2]*s.d[2])+pt*3.1,(q[0]*s.e1[0]+q[1]*s.e1[1]+q[2]*s.e1[2]),(q[0]*s.e2[0]+q[1]*s.e2[1]+q[2]*s.e2[2])];}
// ---------- camera ----------
const cams={hero:{eye:[6.5,-6.0,21],at:[2.9,1.0,0],fov:.66,shift:[0,0]},side:{eye:[6.5,-6.0,29],at:[2.9,1.0,0],fov:.66,shift:[-.36,-.03]}};
const C=cams[CAM];const fw=norm(C.at[0]-C.eye[0],C.at[1]-C.eye[1],C.at[2]-C.eye[2]);const rt=norm(...cross(fw,[0,1,0]));const upv=cross(rt,fw);
const KEY=norm(.55,.55,.62),FILL=norm(-.75,.15,.45),RIM=norm(.65,.35,-.65);
function calcN(x,y,z){const e=.004;const a=map(x+e,y-e,z-e),b=map(x-e,y-e,z+e),c=map(x-e,y+e,z-e),d=map(x+e,y+e,z+e);return norm(a-b-c+d,-a-b+c+d,-a+b-c+d);}
function shadow(x,y,z){let res=1,t=.05;for(let i=0;i<24&&t<12;i++){const h=map(x+KEY[0]*t,y+KEY[1]*t,z+KEY[2]*t);if(h<.002)return 0;res=Math.min(res,8*h/t);t+=clamp(h,.05,.7);}return clamp(res,0,1);}
function ao(x,y,z,n){let o=0,s=1;for(let i=1;i<=4;i++){const h=.14*i;const d=map(x+n[0]*h,y+n[1]*h,z+n[2]*h);o+=(h-d)*s;s*=.6;}return clamp(1-1.6*o,0,1);}
const hx2=h=>[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
const R_ST=['#0d0c0f','#1e1e23','#2c2c32','#3b3b42','#4d4c53','#626067','#7a777c','#95918f'].map(hx2),R_BR=['#1c1810','#3a2c1c','#6a4e2a','#a07a3e','#d2ae68'].map(hx2),R_ICE=['#3b3b42','#6fa8dc','#a9c4d6','#dfe9f0','#eef1f6'].map(hx2),R_MOSS=['#1e1e23','#2f3a2a','#4a5a3a'].map(hx2),R_CRY=['#1e2a4a','#4fb8d8','#6fa8dc','#9ff3ff','#e8feff'].map(hx2),R_COIL=['#4fb8d8','#9ff3ff','#e8feff'].map(hx2);
const BAY=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5].map(v=>(v+.5)/16-.5);let PX=0,PY=0;
function shade(x,y,z,m,pt,rdx,rdy,rdz){const n=calcN(x,y,z);map(x,y,z);const sh=shadow(x+n[0]*.02,y+n[1]*.02,z+n[2]*.02);const occ=ao(x,y,z,n);
  const L0=toLocal([x,y,z]);const q=localOf(pt,x,y,z,L0);
  const dk=Math.max(0,n[0]*KEY[0]+n[1]*KEY[1]+n[2]*KEY[2])*sh,df=Math.max(0,n[0]*FILL[0]+n[1]*FILL[1]+n[2]*FILL[2]);const vd=-(n[0]*rdx+n[1]*rdy+n[2]*rdz);const fr=Math.pow(1-clamp(vd,0,1),3);const rim=fr*Math.max(0,n[0]*RIM[0]+n[1]*RIM[1]+n[2]*RIM[2]+.3);
  let kind='stone',emc=null,em=[0,0,0],spec=.15,shin=12,cid=.5;const fl=PZ.fl;
  if(m===1||m===5){const sc=m===5?1.2:(pt===0?.95:1.35);const wq=[(fbm(q[0]*.6,q[1]*.6,q[2]*.6,2)-.5)*1.4,(fbm(q[0]*.6+7,q[1]*.6,q[2]*.6,2)-.5)*1.4];const[ce,id]=cell3(q[0]*sc+wq[0],q[1]*sc+wq[1],q[2]*sc);cid=id;
    if(m===5){kind='head';spec=.35;shin=24;}
    if(ce<.035&&(id>.35||dk<.4)&&m===1){kind='crack';if(id>.88&&dk>.35){em=[.4,.24,.06];emc='#a07a3e';}}
    if(m===1&&pt!==0&&pt!==1&&fbm(q[0]*.9+5,q[1]*.9,q[2]*.9,2)>.66&&n[1]>.1){kind='ice';spec=.5;shin=40;}
    if(m===1&&pt===0&&L0[1]>1&&n[1]>.5&&fbm(q[0]*2,q[1]*2,q[2]*2+9,2)>.62)kind='moss';
    if(pt===0&&m===1){const X=L0[0],Y=L0[1],Z=L0[2];if(Z>.6&&Math.abs(X)<.06&&Y>0&&Y<4.4){emc='#fff4d6';em=[1.6,1.3,.8];}else if(Z>.6&&Math.abs(X)<.16&&Y>0&&Y<4.4){emc='#ffd27a';em=[.45,.3,.1];}
      const cd=Math.hypot(X,Y-2.35);if(Z>1&&cd<.62){const k=cd/.62;if(k<.55){emc='#fff4d6';em=[2.2,1.7,1];}else if(k<.78){emc='#ff9a3c';em=[1.4,.7,.15];}else kind='bronze';}
      if(X<-1.6&&Y>.6&&Y<3.2){const ry=Y-1.9,rz=Z-.9;const rr=Math.hypot(ry,rz);if(Math.abs(rr-.85)<.13){const a=Math.atan2(rz,ry);if(Math.abs(((a/(2*Math.PI)*20)%1+1)%1-.5)<.24)kind='crack';else{emc='#6b1a2a';em=[.25,.03,.04];}}}}
    if(m===5){const lx=L0[0]-J.head[0],ly=L0[1]-J.head[1],lz=L0[2]-J.head[2];if(Math.abs(ly)<.15&&lz>.7&&Math.abs(lx)<.9){const f=clamp((lx+.85)/1.7,0,1);emc=f<.45?'#ffb347':f<.55?'#fff4d6':'#7fc8ff';em=f<.45?[2,1.1,.3]:f<.55?[2.4,2.2,1.9]:[.5,1.3,2.2];}}}
  if(m===2){kind='bronze';spec=.8;shin=40;}
  if(m===10){kind='pod';spec=.6;shin=30;if(n[1]<-.6){const r1=Math.hypot(((x*2.2)%1+1)%1-.5,((z*2.2)%1+1)%1-.5);if(r1<.25){emc='#ffe9b0';em=[2*PZ.en,1.2*PZ.en,.5*PZ.en];}}}
  if(m===4){kind='coil';em=[.35*fl,1.5*fl,1.8*fl];}
  if(m===8){kind='gold';spec=.7;shin=30;if(h3(Math.floor(L0[0]*14),Math.floor(L0[1]*14),Math.floor(L0[2]*14))>.86){emc='#ffb347';em=[1.6,.9,.3];}}
  if(m===9){kind='crystal';spec=1;shin=60;if(h3(Math.floor(L0[0]*14),Math.floor(L0[1]*14),Math.floor(L0[2]*14))>.82){emc='#7fc8ff';em=[.5,1,1.8];}}
  const amb=.18*occ;
  if(MODE==='dkc'){const v=.72+.56*(cid-.5);const AL={stone:[.13*v,.13*v,.145*v],crack:[.025,.024,.03],ice:[.66,.74,.82],moss:[.11,.14,.08],bronze:[.62,.45,.22],pod:[.3,.22,.12],head:[.17,.17,.19],gold:[.66,.48,.2],crystal:[.3,.52,.78],coil:[.1,.45,.55]}[kind]||[.13,.13,.145];
    if(kind==='head'){spec=.5;shin=28;}if(kind==='stone'){spec=.12;shin=10;}
    const hx_=KEY[0]-rdx,hy_=KEY[1]-rdy,hz_=KEY[2]-rdz;const hl_=Math.hypot(hx_,hy_,hz_);const sp=Math.pow(Math.max(0,(n[0]*hx_+n[1]*hy_+n[2]*hz_)/hl_),shin)*spec*sh*(kind==='crack'?0:1);
    const r=AL[0]*(dk*2.0+df*.35*.5+amb*.6)+rim*.55*.45+sp+em[0],g=AL[1]*(dk*2.0*.93+df*.35*.75+amb*.7)+rim*.55*.75+sp*.95+em[1],b=AL[2]*(dk*2.0*.82+df*.35*1.1+amb*.9)+rim*.55*1.1+sp*.9+em[2];
    const tn=v_=>Math.round(255*Math.pow(clamp(v_/(1+v_*.35),0,1),1/2.2));return[[tn(r),tn(g),tn(b)],em];}
  const bay=BAY[(PY&3)*4+(PX&3)];let colr;
  if(emc&&kind!=='coil')colr=hx2(emc);
  else{const Lv=clamp(dk*.8+df*.16+amb*.9+(kind==='ice'?.08:0),0,1);const pick=(R)=>R[clamp(Math.floor(Lv*R.length*1.15+bay*.5),0,R.length-1)];
    if(kind==='crack')colr=R_ST[Lv>.55?1:0];else if(kind==='moss')colr=pick(R_MOSS);else if(kind==='ice')colr=pick(R_ICE);else if(kind==='bronze'||kind==='gold')colr=pick(R_BR);else if(kind==='pod')colr=R_BR[clamp(Math.floor(Lv*2.6+bay*.5),0,3)];else if(kind==='crystal')colr=pick(R_CRY);
    else if(kind==='coil')colr=R_COIL[clamp(Math.floor((.3+Lv*.6+(fl-1)*.35)*3+bay*.4),0,2)];else colr=R_ST[clamp(Math.floor(Lv*(kind==='head'?.9:.92)*6+bay*.5),0,6)];
    const hx_=KEY[0]-rdx,hy_=KEY[1]-rdy,hz_=KEY[2]-rdz;const hl_=Math.hypot(hx_,hy_,hz_);const sp_=Math.pow(Math.max(0,(n[0]*hx_+n[1]*hy_+n[2]*hz_)/hl_),shin)*spec*sh;
    if(sp_>.35&&kind!=='crack')colr=kind==='bronze'||kind==='gold'||kind==='pod'?hx2('#fff1b8'):hx2('#eef1f6');
    if(rim>.42&&kind!=='crack'&&kind!=='coil')colr=hx2(kind==='ice'?'#eef1f6':'#6fa8dc');}
  return[colr,em];}
const out=new Uint8ClampedArray(W*H*4),glow=new Uint8ClampedArray(W*H*4),depth=new Float32Array(W*H),pos=new Uint8ClampedArray(W*H*4),partb=new Uint8ClampedArray(W*H*4);const tan=Math.tan(C.fov/2);let t0=Date.now();
const tone=v=>Math.round(255*Math.pow(clamp(v/(1+v*.35),0,1),1/2.2));
for(let py_=0;py_<H;py_++){for(let px_=0;px_<W;px_++){PX=px_;PY=py_;const u=((px_+.5)/W*2-1)*tan*(W/H)+C.shift[0],v=-((py_+.5)/H*2-1)*tan+C.shift[1];
  let rx=fw[0]+rt[0]*u+upv[0]*v,ry=fw[1]+rt[1]*u+upv[1]*v,rz=fw[2]+rt[2]*u+upv[2]*v;const l=Math.hypot(rx,ry,rz);rx/=l;ry/=l;rz/=l;
  let tt=10,hit=false;for(let i=0;i<150;i++){const x=C.eye[0]+rx*tt,y=C.eye[1]+ry*tt,z=C.eye[2]+rz*tt;const d=map(x,y,z);if(d<.0025*tt){hit=true;break;}tt+=d*.75;if(tt>45)break;}
  const i=(py_*W+px_)*4;if(hit){const x=C.eye[0]+rx*tt,y=C.eye[1]+ry*tt,z=C.eye[2]+rz*tt;map(x,y,z);const m=MAT,pt=PART;const[c,em]=shade(x,y,z,m,pt,rx,ry,rz);
    out[i]=c[0];out[i+1]=c[1];out[i+2]=c[2];out[i+3]=255;glow[i]=tone(em[0]);glow[i+1]=tone(em[1]);glow[i+2]=tone(em[2]);glow[i+3]=255;depth[py_*W+px_]=tt;
    {const L0=toLocal([x,y,z]);const q=localOf(pt,x,y,z,L0);const o0=(pt>=10&&pt!==12&&pt!==15)?pt*3.1:(pt===12||pt===15?pt:0);const enc=v=>clamp(Math.round((v+8)/16*255),0,255);
     pos[i]=enc(q[0]-o0);pos[i+1]=enc(q[1]);pos[i+2]=enc(q[2]);pos[i+3]=255;partb[i]=pt;partb[i+1]=m;partb[i+2]=0;partb[i+3]=255;}}}}
const key=`${VARIANT}_${CAM}_f${String(FRAME).padStart(2,'0')}`+(MODE==='dkc'?'_dkc':'');
fs.writeFileSync(`pos_${key}.raw`,Buffer.from(pos.buffer));fs.writeFileSync(`part_${key}.raw`,Buffer.from(partb.buffer));
fs.writeFileSync(`out_${key}_toon.raw`,Buffer.from(out.buffer));fs.writeFileSync(`glow_${key}_toon.raw`,Buffer.from(glow.buffer));fs.writeFileSync(`depth_${key}_toon.raw`,Buffer.from(depth.buffer));
function proj(p){const dx=p[0]-C.eye[0],dy=p[1]-C.eye[1],dz=p[2]-C.eye[2];const zf=dx*fw[0]+dy*fw[1]+dz*fw[2];const u=(dx*rt[0]+dy*rt[1]+dz*rt[2])/zf,v=(dx*upv[0]+dy*upv[1]+dz*upv[2])/zf;return[Math.round(((u-C.shift[0])/(tan*(W/H))+1)/2*W),Math.round((1-(v-C.shift[1])/tan)/2*H)];}
const A={podL:proj([J.aL[0],J.aL[1]-1.15,J.aL[2]]),podR:proj([J.aR[0],J.aR[1]-1.15,J.aR[2]]),podLr:proj([J.aL[0]+1.4,J.aL[1]-.9,J.aL[2]]),podRr:proj([J.aR[0]+1.4,J.aR[1]-.9,J.aR[2]]),
  cityLe:proj(toWorld([sLl[0]-.45-1.5,4.3,sLl[2]+.6])),cityRe:proj(toWorld([sRl[0]-.45+1.5,4.3,sRl[2]+.6])),visor:proj(toWorld([J.head[0],J.head[1],J.head[2]+1.4])),fistR:proj(FR.c),en:PZ.en,fl:PZ.fl,th:PZ.th};
fs.writeFileSync(`anchors_${key}_toon.json`,JSON.stringify(A));
console.log('done',key,((Date.now()-t0)/1000).toFixed(1)+'s');
