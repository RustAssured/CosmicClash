// ---------- breaking ----------
// tear a chunk out of a part: its pixels leave the body as a piece that keeps its colours
function tear(P,cid,impX,impY,power){if(!P.alive[cid])return 0;P.alive[cid]=0;const tr=frame.T[P.name],O=frame.O;const ca=Math.cos(tr.ang),sa=Math.sin(tr.ang);const pts=[];let sx=0,sy=0;
  for(let iy=0;iy<P.h;iy++)for(let ix=0;ix<P.w;ix++){const i=iy*P.w+ix;if(P.chunk[i]!==cid||!P.mat[i])continue;const lx=ix+.5-P.pivX,ly=iy+.5-P.pivY;const X=tr.piv[0]+O[0]+lx*ca-ly*sa,Y=tr.piv[1]+O[1]+lx*sa+ly*ca;const[c,em]=shadeAt(P,i,ca,sa,.5,X|0,Y|0);pts.push([X,Y,c,em]);sx+=X;sy+=Y;P.left--;}
  if(!pts.length)return 0;sx/=pts.length;sy/=pts.length;const a=Math.atan2(sy-impY,sx-impX)+(Math.random()-.5)*.6;const sp=(.5+Math.random()*1.4)*power;
  chunks.push({x:sx,y:sy,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,a:0,va:(Math.random()-.5)*2.4*power,px:pts.map(q=>[q[0]-sx,q[1]-sy,q[2],q[3]])});
  // the wound left behind glows
  for(let iy=0;iy<P.h;iy++)for(let ix=0;ix<P.w;ix++){const i=iy*P.w+ix;if(!P.mat[i]||P.chunk[i]===cid||!P.alive[P.chunk[i]])continue;let nb=false;for(const[dx,dy] of[[1,0],[-1,0],[0,1],[0,-1]]){const j=(iy+dy)*P.w+ix+dx;if(ix+dx>=0&&iy+dy>=0&&ix+dx<P.w&&iy+dy<P.h&&P.chunk[j]===cid&&P.mat[j]){nb=true;break;}}if(nb&&Math.random()<.7)P.mat[i]=Math.random()<.5?7:8;}
  return pts.length;}
function hitAt(x,y,power=1){x|=0;y|=0;if(x<0||y<0||x>=W||y>=H||broken)return false;const own=OWN[y*W+x];if(own<0||own>=300)return false;const P=PARTS[ORDER[own]];const ix=OX[y*W+x],iy=OY[y*W+x];hits++;hp=Math.max(0,hp-3*power);
  // the struck chunk tears out, and with a heavy hit its neighbours go too
  const c0=P.chunk[iy*P.w+ix];tear(P,c0,x,y,1+power*.6);if(power>1){const R=7*power;const seen=new Set([c0]);for(let k=0;k<40;k++){const a=Math.random()*TAU,r=Math.random()*R;const jx=Math.round(ix+Math.cos(a)*r),jy=Math.round(iy+Math.sin(a)*r);if(jx<0||jy<0||jx>=P.w||jy>=P.h)continue;const cid=P.chunk[jy*P.w+jx];if(!seen.has(cid)&&P.mat[jy*P.w+jx]){seen.add(cid);if(seen.size<=power*2)tear(P,cid,x,y,1+power*.5);}}}
  flashes.push({x,y,t:0});shake=Math.max(shake,2+power*2);hitstop=Math.max(hitstop,.04*power);
  // a limb whose load-bearing connection fails drifts away whole; one that has lost too much of itself goes in pieces
  {const chainOf={uaL:['uaL','faL','fistL'],faL:['faL','fistL'],fistL:['fistL'],uaR:['uaR','faR','fistR'],faR:['faR','fistR'],fistR:['fistR'],pyL:['pyL'],pyR:['pyR']};if(chainOf[P.name]&&!P.gone&&neckInt(P)<.38){const vx=(Math.random()-.5)*1.2,vy=.3+Math.random()*.3,va=(Math.random()-.5)*.25;for(const n of chainOf[P.name]){const Q=PARTS[n];if(Q.gone)continue;for(let c=0;c<Q.nchunk;c++)if(tear(Q,c,x,y,.01)){const ch=chunks[chunks.length-1];ch.vx=vx;ch.vy=vy;ch.va=va;}Q.gone=true;}shake=Math.max(shake,8);}}
  if(!['chamber','domeL','domeR'].includes(P.name)&&P.left/P.total<.5)shatterPart(P,x,y,1.2);
  if(hp<=0)breakApart();return true;}
function shatterPart(P,x,y,power){for(let c=0;c<P.nchunk;c++)tear(P,c,x,y,power);P.gone=true;}
function breakApart(){if(broken)return;broken=true;brokenT=tNow;hp=0;const cx=frame.T._cores[0][0]+frame.O[0],cy=frame.T._cores[0][1]+frame.O[1];
  // the loop snaps: everything it held flies outward, slowly, around the two dead worlds that stay where they were
  rings.push({x:cx,y:cy,r:6,a:1.4,big:1});flashes.push({x:cx,y:cy,t:-4,big:1});shake=14;slowmo=.3;
  for(const n of ORDER){const P=PARTS[n];if(P.gone)continue;for(let c=0;c<P.nchunk;c++)tear(P,c,cx,cy,n==='chamber'?.35:.55);P.gone=true;}}
// ---------- compose ----------
const off=document.createElement('canvas');off.width=W;off.height=H;const og=off.getContext('2d',{willReadFrequently:true});const fig=document.createElement('canvas');fig.width=W;fig.height=H;const fgc=fig.getContext('2d');const emc=document.createElement('canvas');emc.width=W;emc.height=H;const egc=emc.getContext('2d');
function compose(ctx,t){const o=new Uint8ClampedArray(FB);for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=(y*W+x)*4;if(FB[i+3])continue;if(FB[i-4+3]||FB[i+4+3]||FB[i-W*4+3]||FB[i+W*4+3]){o[i]=4;o[i+1]=4;o[i+2]=8;o[i+3]=255;}}
  fgc.putImageData(new ImageData(o,W,H),0,0);egc.putImageData(new ImageData(EM,W,H),0,0);og.globalAlpha=1;og.globalCompositeOperation='source-over';og.filter='none';space(og,t,'rot');const im=og.getImageData(0,0,W,H);quantize(im,18);ctx.putImageData(im,0,0);
  if(false){ctx.save();ctx.globalAlpha=.55;const ox=CX+248,oy=CY+40;ctx.strokeStyle='#d9a15a';ctx.lineWidth=1;ctx.beginPath();ctx.arc(ox,oy,10,0,TAU);ctx.stroke();ctx.beginPath();ctx.moveTo(ox-16,oy);ctx.lineTo(ox-6,oy);ctx.moveTo(ox+6,oy);ctx.lineTo(ox+16,oy);ctx.moveTo(ox,oy-16);ctx.lineTo(ox,oy-6);ctx.moveTo(ox,oy+6);ctx.lineTo(ox,oy+16);ctx.stroke();ctx.restore();}
  ctx.drawImage(fig,0,0);ctx.save();ctx.globalCompositeOperation='lighter';ctx.globalAlpha=.38;ctx.filter='blur(3px)';ctx.drawImage(emc,0,0);ctx.filter='blur(10px)';ctx.globalAlpha=.28;ctx.drawImage(emc,0,0);ctx.restore();ctx.filter='none';
  for(const p of dust){ctx.fillStyle=`rgba(${p.c[0]},${p.c[1]},${p.c[2]},${Math.max(0,p.life)})`;ctx.fillRect(Math.round(p.x),Math.round(p.y),1,1);}
  for(const r of rings){ctx.strokeStyle=`rgba(230,240,255,${Math.max(0,r.a)})`;ctx.lineWidth=r.big?3:2;ctx.beginPath();ctx.ellipse(r.x,r.y,r.r,r.r*(r.big?.55:.8),0,0,TAU);ctx.stroke();}
  for(const f of flashes){if(f.t<0)continue;const a=(f.big?1:.85)-f.t*(f.big?.08:.2);if(a<=0)continue;ctx.fillStyle=`rgba(255,244,220,${a})`;ctx.beginPath();ctx.arc(f.x,f.y,(f.big?10:4)+f.t*(f.big?14:4),0,TAU);ctx.fill();}}
function stepFx(dt){for(const p of dust){p.x+=p.vx*dt*60;p.y+=p.vy*dt*60;p.vx*=.96;p.vy*=.96;p.life-=.016*dt*60;}dust=dust.filter(p=>p.life>0);for(const r of rings){r.r+=(r.big?7:5)*dt*60;r.a-=(r.big?.012:.05)*dt*60;}rings=rings.filter(r=>r.a>0);for(const f of flashes)f.t+=dt*60/2;flashes=flashes.filter(f=>f.t<20);shake*=Math.pow(.86,dt*60);if(slowmo<1)slowmo=Math.min(1,slowmo+dt*.35);}