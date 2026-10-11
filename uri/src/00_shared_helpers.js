'use strict';
const W=640,H=360,TAU=Math.PI*2;
const clamp=(v,a,b)=>v<a?a:v>b?b:v,lerp=(a,b,t)=>a+(b-a)*t,sst=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const hex=h=>[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
const rgba=(h,a=1)=>{const c=typeof h==='string'?hex(h):h;return `rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;};
function rng(s){return()=>{s|=0;s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function h3(x,y,z){let h=Math.imul(x,374761393)+Math.imul(y,668265263)+Math.imul(z,1274126177)|0;h=Math.imul(h^(h>>>13),1274126177);return((h^(h>>>16))>>>0)/4294967295;}
function n3(x,y,z){const xi=Math.floor(x),yi=Math.floor(y),zi=Math.floor(z);const xf=x-xi,yf=y-yi,zf=z-zi;const u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf),w=zf*zf*(3-2*zf);
  const a=lerp(lerp(h3(xi,yi,zi),h3(xi+1,yi,zi),u),lerp(h3(xi,yi+1,zi),h3(xi+1,yi+1,zi),u),v),b=lerp(lerp(h3(xi,yi,zi+1),h3(xi+1,yi,zi+1),u),lerp(h3(xi,yi+1,zi+1),h3(xi+1,yi+1,zi+1),u),v);return lerp(a,b,w);}
function fbm(x,y,z,o){let s=0,a=.5,f=1,n=0;for(let i=0;i<o;i++){s+=a*n3(x*f,y*f,z*f);n+=a;a*=.5;f*=2.03;}return s/n;}

// ---------- palette and dither ----------
const PAL=['#000000','#03040a','#080a16','#0f1124','#171a33','#120a1c','#22122e','#33183f',
 '#16302e','#0c1513','#16261f','#22392f','#355647','#4f7d68','#7aa898','#b4d3c3',
 '#3b3428','#6e634c','#a89c7e','#d9cfb1','#f3eedb','#2a1e0c','#5c4216','#8f6b24','#c39b3e','#e9c96c','#fff1b8','#7fe8de','#e6fffb',
 '#0b1a3a','#13306a','#1d4c96','#2f74c0','#7fb4ff','#2e5a2a','#4f7f3a','#8a9a52','#b39a6a','#c7d4e8','#eef1f6','#060a18',
 '#0b0709','#1d1013','#351a1e','#57292c','#7f4440','#aa6a5e','#d5a28f','#f0d6c6','#2a0609','#5a1014','#8a1f1c','#b8ff3c','#ff3fd2','#6b2a8a','#ffffff','#141014','#241b20','#3a2c30','#564246','#7a6462','#a08c86','#c6b6ac','#e2d8cc','#07040a','#140a10','#24101a','#3a1424','#6b1a2a','#9a2a3c','#d0546a','#f0e2cc','#c8b49a','#8f7a64','#4e3e34','#9aa4b8','#dfe6f2','#ff5a8a','#b03aa0','#07090a','#0e1414','#172120','#24332f','#3b524a','#6f8f84','#1c1810','#3a3020','#5e4a2a','#0d0c0f','#1c1a1f','#2e2a2e','#47403d','#6b5f55','#93857a','#3a2c1c','#6a4e2a','#a07a3e','#d2ae68','#9ff3ff','#e8feff','#4fb8d8','#fff4d6','#ffd27a','#ff9a3c','#ffb347','#7fc8ff','#6fa8dc','#ffe9b0','#b84a2a','#2f3a2a','#4a5a3a','#dfe9f0','#a9c4d6','#1e1e23','#2c2c32','#3b3b42','#4d4c53','#626067','#7a777c','#95918f'].map(hex);
const LUT=new Uint8Array(32768);
(function(){for(let r=0;r<32;r++)for(let g=0;g<32;g++)for(let b=0;b<32;b++){const R=r*8+4,G=g*8+4,B=b*8+4;let bi=0,bd=1e9;
  for(let i=0;i<PAL.length;i++){const p=PAL[i];const dr=R-p[0],dg=G-p[1],db=B-p[2];const d=dr*dr*.3+dg*dg*.59+db*db*.11;if(d<bd){bd=d;bi=i;}}LUT[(r<<10)|(g<<5)|b]=bi;}})();
const BAY=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5].map(v=>(v+.5)/16-.5);
function quantize(img,spread=26){const d=img.data,w=img.width;for(let i=0,p=0;i<d.length;i+=4,p++){const x=p%w,y=(p/w)|0;const o=BAY[(y&3)*4+(x&3)]*spread;
  const r=clamp(d[i]+o,0,255)>>3,g=clamp(d[i+1]+o,0,255)>>3,b=clamp(d[i+2]+o,0,255)>>3;const c=PAL[LUT[(r<<10)|(g<<5)|b]];d[i]=c[0];d[i+1]=c[1];d[i+2]=c[2];d[i+3]=255;}}

// ---------- shared scenery ----------
const STARS=(()=>{const r=rng(7);const a=[];for(let i=0;i<260;i++)a.push({x:r()*W,y:r()*H,b:r(),ph:r()*TAU,c:r()});return a;})();
function space(g,t,tone){
  const top=tone==='rot'?'#0a0612':'#03040c',bot=tone==='rot'?'#140a1c':'#08101a';
  const gr=g.createLinearGradient(0,0,0,H);gr.addColorStop(0,top);gr.addColorStop(1,bot);g.fillStyle=gr;g.fillRect(0,0,W,H);
  const blobs=tone==='rot'?[[160,90,240,'#33183f',.55],[470,300,260,'#2a0609',.5],[520,60,180,'#22122e',.5],[90,320,200,'#120a1c',.6]]:[[150,120,260,'#16302e',.45],[500,290,240,'#171a33',.6],[560,70,200,'#2a1e0c',.35],[60,300,180,'#0f1124',.6]];
  for(const[x,y,r,c,a]of blobs){const rg=g.createRadialGradient(x,y,0,x,y,r);rg.addColorStop(0,rgba(c,a));rg.addColorStop(1,rgba(c,0));g.fillStyle=rg;g.fillRect(0,0,W,H);}
  for(const s of STARS){const tw=.5+.5*Math.sin(t*(.6+s.b)+s.ph);const a=(.25+.75*s.b)*tw;g.fillStyle=s.c<.15?rgba('#e9c96c',a):s.c<.3?rgba('#7fb4ff',a):rgba('#eef1f6',a);g.fillRect(s.x|0,s.y|0,1,1);if(s.b>.96){g.fillStyle=rgba('#eef1f6',a*.5);g.fillRect((s.x|0)-1,s.y|0,3,1);g.fillRect(s.x|0,(s.y|0)-1,1,3);}}
}
// the Planet, rendered per pixel
const planetCache={};
function planet(g,cx,cy,r,t){
  const key=r;let c=planetCache[key];if(!c){c=document.createElement('canvas');c.width=c.height=r*2+8;planetCache[key]=c;}
  const pg=c.getContext('2d');const img=pg.createImageData(c.width,c.height);const d=img.data;const o=r+4;const rot=t*.05,cr=Math.cos(rot),sr=Math.sin(rot);
  const L=[-.55,-.45,.7];const ll=Math.hypot(...L);L[0]/=ll;L[1]/=ll;L[2]/=ll;
  for(let y=-r-3;y<=r+3;y++)for(let x=-r-3;x<=r+3;x++){const i=((y+o)*c.width+(x+o))*4;const dd=Math.sqrt(x*x+y*y)/r;
    if(dd>1){if(dd<1.08){const a=(1-(dd-1)/.08);const lit=clamp(.4+(-x*L[0]-y*L[1])/r,0,1);d[i]=127;d[i+1]=180;d[i+2]=255;d[i+3]=a*a*160*lit;}continue;}
    const nx=x/r,ny=y/r,nz=Math.sqrt(Math.max(0,1-nx*nx-ny*ny));const X=nx*cr-nz*sr,Z=nx*sr+nz*cr,Y=ny;
    const h=fbm(X*1.7+3.1,Y*1.7,Z*1.7,4);const land=h>.53;const cl=fbm(X*2.6+9+t*.01,Y*3.2,Z*2.6,3);
    const dif=clamp(nx*L[0]+ny*L[1]+nz*L[2],0,1);let col;
    if(land){const e=clamp((h-.53)/.2,0,1);col=e<.3?[46,90,42]:e<.6?[79,127,58]:e<.85?[138,154,82]:[179,154,106];}
    else{const dp=clamp((.53-h)/.25,0,1);col=[lerp(47,11,dp),lerp(116,26,dp),lerp(192,58,dp)];}
    if(cl>.6){const k=clamp((cl-.6)/.12,0,1);col=[lerp(col[0],238,k),lerp(col[1],241,k),lerp(col[2],246,k)];}
    const sh=.08+.92*dif;const rim=Math.pow(1-nz,3)*.8*clamp(dif+.3,0,1);
    d[i]=clamp(col[0]*sh+127*rim,0,255);d[i+1]=clamp(col[1]*sh+180*rim,0,255);d[i+2]=clamp(col[2]*sh+255*rim+(1-dif)*8,0,255);d[i+3]=255;}
  pg.putImageData(img,0,0);g.drawImage(c,cx-o,cy-o);
}
