# bake: one shared limited palette for all frames (DKC-style), no dithering, orphan cleanup, a selective outline
import numpy as np
from PIL import Image
W,H,N=640,360,28
fr=[np.frombuffer(open(f'out_hero_hero_f{i:02d}_dkc_toon.raw','rb').read(),dtype=np.uint8).reshape(H,W,4).copy() for i in range(N)]
for f in fr:
    f[:,:,:3]=(np.power(f[:,:,:3]/255.0,1.18)*255*.92).astype(np.uint8)
# palette from all figure pixels; emissive colours are forced in so they survive
pix=np.concatenate([f[f[:,:,3]>0][:,:3] for f in fr])
samp=pix[np.random.default_rng(1).choice(len(pix),min(len(pix),200000),replace=False)]
im=Image.fromarray(samp.reshape(-1,400,3)[:500],'RGB') if len(samp)>=200000 else Image.fromarray(samp.reshape(1,-1,3),'RGB')
pal_img=im.quantize(colors=36,method=Image.Quantize.MEDIANCUT)
pal=np.array(pal_img.getpalette()[:36*3]).reshape(-1,3)
forced=np.array([[7,9,10],[255,244,214],[255,210,122],[255,154,60],[255,179,71],[127,200,255],[159,243,255],[232,254,255],[107,26,42],[255,233,176]])
pal=np.concatenate([pal,forced]).astype(np.int32)
def nearest(rgb):
    d=((rgb[:,None,:].astype(np.int32)-pal[None,:,:])**2).sum(-1);return pal[d.argmin(1)]
for i,f in enumerate(fr):
    a=f[:,:,3]>0;out=np.zeros((H,W,4),np.uint8)
    q=nearest(f[a][:,:3]);img=np.zeros((H,W,3),np.int32);img[a]=q
    # orphan cleanup: a lone pixel that disagrees with all four neighbours takes the majority colour
    for _ in range(2):
        up=np.roll(img,1,0);dn=np.roll(img,-1,0);lf=np.roll(img,1,1);rt=np.roll(img,-1,1)
        same=lambda x,y:(x==y).all(-1)
        lone=a&~same(img,up)&~same(img,dn)&~same(img,lf)&~same(img,rt)
        maj=a&same(up,dn)
        sel=lone&maj;img[sel]=up[sel]
        maj2=a&same(lf,rt)&lone&~maj;img[maj2]=lf[maj2]
    out[a,:3]=img[a];out[a,3]=255
    # selective outline: dark on the shadow side (left, bottom), none on the lit side
    nb=np.zeros((H,W),bool)
    for dy,dx in[(0,1),(-1,0),(1,0),(0,-1)]:
        nb|=np.roll(np.roll(a,dy,0),dx,1)
    edge=(~a)&nb
    lit=np.roll(a,1,1)&~np.roll(a,-1,1)  # background pixel just right of the figure: the lit side
    o=edge&~lit
    out[o,:3]=[7,9,10];out[o,3]=255
    Image.fromarray(out,'RGBA').save(f'dkc_f{i:02d}.png')
    for k in['pos','part']:
        Image.fromarray(np.frombuffer(open(f'{k}_hero_hero_f{i:02d}_dkc.raw','rb').read(),dtype=np.uint8).reshape(H,W,4),'RGBA').save(f'{k}_f{i:02d}.png')
    g=np.frombuffer(open(f'glow_hero_hero_f{i:02d}_dkc_toon.raw','rb').read(),dtype=np.uint8).reshape(H,W,4);Image.fromarray(g,'RGBA').save(f'dkcglow_f{i:02d}.png')
print('baked',len(pal))
