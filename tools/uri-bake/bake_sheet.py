import numpy as np,json,glob,os
from PIL import Image
D='parts';OUT='pack/assets/uri';os.makedirs(OUT,exist_ok=True)
mans=[json.load(open(f)) for f in sorted(glob.glob(D+'/*.json'))]
cols={}
for m in mans:
    s=m['size'];a=np.frombuffer(open(f"{D}/{m['key']}_col.raw",'rb').read(),dtype=np.uint8).reshape(s,s,4).copy()
    a[:,:,:3]=(np.power(a[:,:,:3]/255.0,1.18)*255*.92).astype(np.uint8);cols[m['key']]=a
pix=np.concatenate([a[a[:,:,3]>0][:,:3] for a in cols.values()])
samp=pix[np.random.default_rng(1).choice(len(pix),min(len(pix),120000),replace=False)]
pal=np.array(Image.fromarray(samp.reshape(1,-1,3),'RGB').quantize(colors=36,method=Image.Quantize.MEDIANCUT).getpalette()[:108]).reshape(-1,3)
forced=np.array([[255,244,214],[255,210,122],[255,154,60],[255,179,71],[127,200,255],[159,243,255],[232,254,255],[107,26,42],[255,233,176]])
pal=np.concatenate([pal,forced]).astype(np.int32)
for m in mans:
    k=m['key'];a=cols[k];s=m['size'];msk=a[:,:,3]>0
    rgb=a[msk][:,:3].astype(np.int32);q=pal[((rgb[:,None,:]-pal[None])**2).sum(-1).argmin(1)]
    img=np.zeros((s,s,3),np.int32);img[msk]=q
    for _ in range(2):
        up=np.roll(img,1,0);dn=np.roll(img,-1,0);lf=np.roll(img,1,1);rt=np.roll(img,-1,1);same=lambda x,y:(x==y).all(-1)
        lone=msk&~same(img,up)&~same(img,dn)&~same(img,lf)&~same(img,rt);sel=lone&same(up,dn);img[sel]=up[sel];sel2=lone&~same(up,dn)&same(lf,rt);img[sel2]=lf[sel2]
    out=np.zeros((s,s,4),np.uint8);out[msk,:3]=img[msk];out[msk,3]=255
    Image.fromarray(out,'RGBA').save(f'{OUT}/{k}.png')
    for t in['glow','pos','part']:
        Image.fromarray(np.frombuffer(open(f"{D}/{k}_{t}.raw",'rb').read(),dtype=np.uint8).reshape(s,s,4),'RGBA').save(f'{OUT}/{k}_{t}.png')
json.dump({m['key']:m for m in mans},open(f'{OUT}/manifest.json','w'),indent=1)
json.dump(pal.tolist(),open(f'{OUT}/palette.json','w'))
print('ok',len(mans),'parts',len(pal),'colours')
