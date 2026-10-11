import numpy as np, json
from PIL import Image, ImageDraw
from scipy import ndimage as nd
im=Image.open('../../reference/uri_front_reference.png').convert('RGB');a=np.array(im).astype(float);H,W=a.shape[:2]
bg=np.array([4,10,18.]);d=np.sqrt(((a-bg)**2).sum(2))
m=d>24;m[:12,:]=False;m[318:,:]=False
m=nd.binary_closing(m,iterations=2)
lab,n=nd.label(m);sizes=nd.sum(m,lab,range(1,n+1));keep=np.zeros_like(m)
for i,s in enumerate(sizes):
    if s>30:keep|=lab==i+1
# fill small interior holes only: real gaps between arms and body stay open
inv=~keep;hl,hn=nd.label(inv);hs=nd.sum(inv,hl,range(1,hn+1))
for i,s in enumerate(hs):
    reg=hl==i+1
    if s<260 and not (reg[0,:].any() or reg[-1,:].any() or reg[:,0].any() or reg[:,-1].any()):keep|=reg
m=keep
# parts as polygons in reference pixels, by priority
P=[('moon',[(176,8),(206,8),(206,40),(176,40)]),
 ('fistL',[(20,228),(70,215),(120,232),(122,300),(90,318),(30,312),(14,270)]),
 ('fistR',[(285,236),(330,220),(380,232),(392,280),(360,318),(300,316),(280,280)]),
 ('armL',[(0,140),(40,120),(80,140),(95,200),(80,240),(20,250),(0,215)]),
 ('armR',[(312,140),(360,120),(400,140),(403,220),(380,245),(320,240),(300,200)]),
 ('pyL',[(105,215),(150,205),(175,230),(165,320),(115,320),(100,260)]),
 ('pyR',[(205,225),(250,215),(285,230),(275,320),(220,320),(205,270)]),
 ('arkL',[(28,80),(70,50),(135,55),(165,80),(150,140),(120,175),(80,170),(30,150)]),
 ('arkR',[(225,40),(300,30),(352,58),(370,110),(355,160),(310,165),(262,110),(230,80)]),
 ('chamber',[(120,40),(260,30),(310,140),(300,240),(200,262),(110,235),(95,140)])]
lbl=np.zeros((H,W),np.int16);names=[p[0] for p in P]
for k,(nm,poly) in reversed(list(enumerate(P))):
    pm=Image.new('L',(W,H),0);ImageDraw.Draw(pm).polygon(poly,fill=1);pm=np.array(pm).astype(bool)
    lbl[pm&m]=k+1
# leftovers: nearest labelled pixel
left=m&(lbl==0)
if left.any():
    dist,(iy,ix)=nd.distance_transform_edt(lbl==0,return_indices=True);lbl[left]=lbl[iy[left],ix[left]]
np.save('lbl.npy',lbl);np.save('mask.npy',m)
cols=np.array([[0,0,0]]+[[int(c) for c in np.random.default_rng(k).integers(60,255,3)] for k in range(len(P))],np.uint8)
Image.fromarray(cols[lbl]).resize((W*2,H*2),Image.NEAREST).save('/tmp/parts.png')
print(names,[(lbl==k+1).sum() for k in range(len(P))])
