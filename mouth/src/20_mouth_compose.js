// ---------- compose: depth contours, outline, bloom ----------
function compose(ctx,t,bg=true){const o=new Uint8ClampedArray(FB);
  for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x,j=i*4;if(!FB[j+3]){if(FB[j-4+3]||FB[j+4+3]||FB[j-W*4+3]||FB[j+W*4+3]){o[j]=4;o[j+1]=2;o[j+2]=6;o[j+3]=255;}continue;}
    // where one strand passes over another, a dark seam: the braid reads as separate ropes of flesh
    const z=ZB[i];if((ZB[i+1]>z+5&&FB[j+4+3])||(ZB[i+W]>z+5&&FB[j+W*4+3])||(ZB[i-1]>z+5&&FB[j-4+3])||(ZB[i-W]>z+5&&FB[j-W*4+3])){if(!EM[j+3]){o[j]=o[j]*.25|0;o[j+1]=o[j+1]*.2|0;o[j+2]=o[j+2]*.3|0;}}}
  fg.putImageData(new ImageData(o,W,H),0,0);eg.putImageData(new ImageData(EM,W,H),0,0);
  if(bg){if(!compose.bgT||t-compose.bgT>.5||t<compose.bgT){space(og,t,'rot');const im=og.getImageData(0,0,W,H);quantize(im,18);og.putImageData(im,0,0);compose.bgT=t;}ctx.drawImage(off,0,0);}
  ctx.drawImage(fig,0,0);ctx.save();ctx.globalCompositeOperation='lighter';ctx.globalAlpha=.55;ctx.filter='blur(3px)';ctx.drawImage(emc,0,0);ctx.filter='blur(12px)';ctx.globalAlpha=.4;ctx.drawImage(emc,0,0);ctx.restore();ctx.filter='none';}
const off=document.createElement('canvas');off.width=W;off.height=H;const og=off.getContext('2d',{willReadFrequently:true});const fig=document.createElement('canvas');fig.width=W;fig.height=H;const fg=fig.getContext('2d');const emc=document.createElement('canvas');emc.width=W;emc.height=H;const eg=emc.getContext('2d');

