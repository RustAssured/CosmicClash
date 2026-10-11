
{// ================= 우리: the dressed rig — motion, weight, breaking =================
const RIG=__RIG__;const REFIMG='__REFIMG__';const REFSIL='__REFSIL__';
const dec=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));const dec16=s=>{const b=dec(s);return new Uint16Array(b.buffer,b.byteOffset,b.length/2);};
const HX=h=>[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
const RP={s1:['#08060a','#120d11','#1d1619','#2a1f21','#382a29','#4a3834','#5f4a42','#776053','#937a68','#b3987f','#cfb79a'],s2:['#07070c','#100f17','#1a1824','#252232','#312c40','#3f3850','#504762','#645a76','#7c708c','#978ba5','#b3a8bd'],
 civ:['#e88a3a','#ffb060','#ffd890'],field:['#3a5ac8','#6a92f8','#b0ccff'],hot:['#1a0604','#3a0c06','#6a1a0a','#9a300e','#c45018','#e07428','#f49a48','#ffc480'],cold:['#0c0a2a','#1e1a5a','#3a2e8e','#5a4ac0','#8a6ee0','#c08ef0','#f0b8f8','#fff0ff']};
const RX={};for(const k in RP)RX[k]=RP[k].map(HX);
const BY=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5].map(v=>(v+.5)/16-.5);
const ramp=(R,l,x,y)=>{let k=Math.floor(l*R.length*1.02+BY[(y&3)*4+(x&3)]*.6);return R[k<0?0:k>=R.length?R.length-1:k];};
const LS=(()=>{const l=[-.55,-.62,.56],n=Math.hypot(...l);return l.map(v=>v/n);})();
const ORDER=RIG.order;const ORX=200,ORY=170,CX=320,CY=186;
// ---------- parts ----------
let PARTS;function build(){PARTS={};RIG.parts.forEach((p,i)=>{PARTS[p.name]={name:p.name,i,w:p.w,h:p.h,x0:p.x0,y0:p.y0,pivX:p.pivX,pivY:p.pivY,pg:p.pg,joints:p.joints,kind:p.kind,
  mat:dec(p.mat),surf:dec(p.surf),tone:dec(p.tone),form:dec(p.form),nx:dec(p.nx),ny:dec(p.ny),nz:dec(p.nz),edge:dec(p.edge),chunk:dec16(p.chunk),alive:new Uint8Array(p.nchunk).fill(1),nchunk:p.nchunk,total:0,gone:false};
  const P=PARTS[p.name];for(let k=0;k<P.mat.length;k++)if(P.mat[k])P.total++;P.left=P.total;});}
build();
// ---------- buffers ----------
const FB=new Uint8ClampedArray(W*H*4),EM=new Uint8ClampedArray(W*H*4),OWN=new Int16Array(W*H),OX=new Int16Array(W*H),OY=new Int16Array(W*H),ZB=new Int8Array(W*H);
function clr(){FB.fill(0);EM.fill(0);OWN.fill(-1);ZB.fill(-1);}
function px(x,y,c,em,own,ox,oy,z){x|=0;y|=0;if(x<0||y<0||x>=W||y>=H)return;const i=y*W+x,j=i*4;FB[j]=c[0];FB[j+1]=c[1];FB[j+2]=c[2];FB[j+3]=255;if(em){EM[j]=c[0];EM[j+1]=c[1];EM[j+2]=c[2];EM[j+3]=255;}else EM[j+3]=0;OWN[i]=own;OX[i]=ox;OY[i]=oy;ZB[i]=z;}
// ---------- shading ----------
function shadeAt(P,i,ca,sa,wForm,x,y){const mat=P.mat[i];
  switch(mat){case 3:return[RX.civ[(x*7+y*3)%3],1];case 2:return[RX.field[(x+y)%3===0?2:1],1];case 9:return[x%2?[255,190,120]:[180,220,255],1];case 7:{const g=((x+y)%4===0)||((x-y)%4===0);return[g?[255,214,150]:[44,20,10],1];}case 8:return[[255,170,90],1];}
  const lnx=(P.nx[i]-128)/120,lny=(P.ny[i]-128)/120,lnz=P.nz[i]/250;const snx=lnx*ca-lny*sa,sny=lnx*sa+lny*ca;const dk=Math.max(0,snx*LS[0]+sny*LS[1]+lnz*LS[2]);
  const form=P.form[i]/255,tone=P.tone[i]/255;let lum=wForm*form*1.3+(1-wForm)*(.06+.58*dk)+(tone-.5)*.22;if(mat===10)lum*=.3;
  let c=ramp(P.surf[i]===2?RX.s2:RX.s1,lum,x,y);const rim=Math.pow(1-lnz,2)*Math.max(0,snx*.9-sny*.1);if(rim>.5&&mat===1&&wForm>.4)c=[(c[0]*.6+110*.4)|0,(c[1]*.6+118*.4)|0,(c[2]*.6+160*.4)|0];return[c,0];}
// draw a part about its pivot; each screen pixel samples the part at four points and keeps the majority — rotation without smear or sparkle
function drawPart(P,px0,py0,ang,z){const ca=Math.cos(ang),sa=Math.sin(ang);const wForm=Math.max(0,Math.cos(ang))**3*.82;const ext=Math.hypot(P.w,P.h)+2;
  const bx0=Math.max(0,Math.floor(px0-ext)),bx1=Math.min(W-1,Math.ceil(px0+ext)),by0=Math.max(0,Math.floor(py0-ext)),by1=Math.min(H-1,Math.ceil(py0+ext));const rotated=Math.abs(ang)>.02;
  for(let y=by0;y<=by1;y++)for(let x=bx0;x<=bx1;x++){let best=-1;
    if(!rotated){const ix=Math.floor(x+.5-px0+P.pivX),iy=Math.floor(y+.5-py0+P.pivY);if(ix<0||iy<0||ix>=P.w||iy>=P.h)continue;const i=iy*P.w+ix;if(!P.mat[i]||!P.alive[P.chunk[i]])continue;best=i;}
    else{let cnt=0,cand=-1,center=-1;for(let s=0;s<4;s++){const ox=(s&1)?.75:.25,oy=(s&2)?.75:.25;const dx=x+ox-px0,dy=y+oy-py0;const u=dx*ca+dy*sa,v=-dx*sa+dy*ca;const ix=Math.floor(u+P.pivX),iy=Math.floor(v+P.pivY);if(ix<0||iy<0||ix>=P.w||iy>=P.h)continue;const i=iy*P.w+ix;if(!P.mat[i]||!P.alive[P.chunk[i]])continue;cnt++;if(cand<0)cand=i;if(s===3||center<0)center=i;}
      if(cnt<2)continue;best=center;}
    const[c,em]=shadeAt(P,best,ca,sa,wForm,x,y);const ix=best%P.w,iy=(best/P.w)|0;let col=c;if(!em&&P.edge[best]<=1.01)col=[c[0]*.55|0,c[1]*.55|0,c[2]*.6|0];px(x,y,col,em,P.i,ix,iy,z);}}
// ---------- cores and loop ----------
function genCore(R,hot){const TW=Math.round(TAU*R),TH=R*2;const t={w:TW,h:TH,mat:new Uint8Array(TW*TH),tone:new Uint8Array(TW*TH),hot};
  for(let v=0;v<TH;v++)for(let u=0;u<TW;u++){const a=u/TW*TAU,X=Math.cos(a)*R,Z=Math.sin(a)*R;const i=v*TW+u;const n=fbm(X*.13+(hot?0:9),v*.13,Z*.13,3);if(hot){const cr=1-Math.abs(2*n3(X*.25,v*.25,Z*.25)-1);t.mat[i]=cr>.9?2:1;}else{const sw=Math.sin(v*.6+n*8);t.mat[i]=sw>.7?2:1;}t.tone[i]=Math.max(0,Math.min(255,n*255));}return t;}
let HOTC,COLDC;function buildCores(){HOTC={R:Math.round(RIG.hot[2]),x:RIG.hot[0],y:RIG.hot[1],tex:genCore(Math.round(RIG.hot[2]),true)};COLDC={R:Math.round(RIG.cold[2]),x:RIG.cold[0],y:RIG.cold[1],tex:genCore(Math.round(RIG.cold[2]),false)};}buildCores();
let CSPIN=0;function drawCore(C,cx,cy,dim){const t=C.tex,R=C.R,hot=t.hot;for(let v=0;v<2*R;v++){const ny=-(v+.5-R)/R;const rr=R*Math.sqrt(Math.max(0,1-ny*ny));const y=Math.round(cy-R+v);for(let x=Math.floor(cx-rr);x<=Math.ceil(cx+rr);x++){const s=(x+.5-cx)/rr;if(s<-1||s>1)continue;const nx=(x+.5-cx)/R;const nz=Math.sqrt(Math.max(0,1-nx*nx-ny*ny));
  const u=((Math.floor((Math.asin(s)+CSPIN*(hot?1:-1.3))/TAU*t.w)%t.w)+t.w)%t.w;const i=v*t.w+u;const mat=t.mat[i],tn=t.tone[i]/255;let c;if(mat===8)c=[255,240,200];else{const lit=Math.max(0,-nx*.5+ny*.5+nz*.7);c=hot?(mat===2?ramp(RX.hot,(.62+tn*.35)*dim,x,y):ramp(RX.hot,(.02+tn*.5+lit*.16)*dim,x,y)):(mat===2?ramp(RX.cold,(.55+tn*.45)*dim,x,y):ramp(RX.cold,(.12+tn*.45+lit*.25)*dim,x,y));}
  if(Math.pow(1-nz,2)>.55&&dim>.8)c=hot?[255,170,90]:[230,170,255];px(x,y,c,1,hot?300:301,u,v,5);}}}
function loopPts(A,B,hp,t){const mx=(A[0]+B[0])/2,my=(A[1]+B[1])/2;const dx=B[0]-A[0],dy=B[1]-A[1];const d=Math.hypot(dx,dy)||1;const ux=dx/d,uy=dy/d;const pts=[];const dmg=1-hp/100;
  for(let k=0;k<520;k++){const s=k/520*TAU;const den=1+Math.sin(s)**2;let lx=d*Math.cos(s)/den*1.3,ly=d*Math.sin(s)*Math.cos(s)/den*1.35;ly+=(1+8*dmg)*(n3(k*.08,t*2.2,3)-.5);pts.push([mx+lx*ux-ly*uy,my+lx*uy+ly*ux,Math.sin(s)*(Math.cos(s)>0?1:-1),s]);}return pts;}
function orbitPts(C,t,hp){const pts=[];const dmg=1-hp/100;for(let k=0;k<300;k++){const s=k/300*TAU;const R=C.R*1.6;const x=Math.cos(s)*R,y=Math.sin(s)*R*.34;const r=-.36;pts.push([C.x+x*Math.cos(r)-y*Math.sin(r),C.y+x*Math.sin(r)+y*Math.cos(r)+(1+6*dmg)*(n3(k*.1,t*2,5)-.5),Math.sin(s),s+1.6]);}return pts;}
function drawLoop(pts,front,hp,t){const dmg=1-hp/100;for(let k=0;k<pts.length;k++){const p=pts[k];if((p[2]>0)!==front)continue;if(dmg>.4&&n3(k*.2,t*6,9)<(dmg-.4)*1.2)continue;const cross=Math.abs(Math.sin(p[3]))<.1;const c=cross?[255,255,255]:front?(k%7<3?[248,244,255]:[214,196,255]):[150,130,220];px(p[0],p[1],c,1,-1,0,0,front?6:4);if(hp>40)px(p[0],p[1]+1,front?[170,140,250]:[90,80,170],1,-1,0,0,front?6:4);}}