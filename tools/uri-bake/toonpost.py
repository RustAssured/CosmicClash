import sys,numpy as np
from PIL import Image
w,h,key=int(sys.argv[1]),int(sys.argv[2]),sys.argv[3]
o=np.frombuffer(open(f'out_{key}_toon.raw','rb').read(),dtype=np.uint8).reshape(h,w,4).copy()
dep=np.frombuffer(open(f'depth_{key}_toon.raw','rb').read(),dtype=np.float32).reshape(h,w)
a=o[:,:,3]>0
OUT=np.array([7,9,10],dtype=np.uint8);INN=np.array([13,12,15],dtype=np.uint8)
res=o.copy()
# outer outline: background pixels touching the figure
nb=np.zeros_like(a)
for dy,dx in[(1,0),(-1,0),(0,1),(0,-1)]:nb|=np.roll(np.roll(a,dy,0),dx,1)
edge=(~a)&nb
res[edge,:3]=OUT;res[edge,3]=255
# inner outline: where a much nearer surface sits next to this one
inner=np.zeros_like(a)
for dy,dx in[(1,0),(-1,0),(0,1),(0,-1)]:
    nd=np.roll(np.roll(dep,dy,0),dx,1);na=np.roll(np.roll(a,dy,0),dx,1)
    inner|=a&na&((dep-nd)>0.55)
res[inner,:3]=INN
Image.fromarray(res,'RGBA').save(f'out_{key}_toon.png')
g=np.frombuffer(open(f'glow_{key}_toon.raw','rb').read(),dtype=np.uint8).reshape(h,w,4)
Image.fromarray(g,'RGBA').save(f'glow_{key}_toon.png')
bg=Image.new('RGBA',(w,h),(8,10,22,255));bg.alpha_composite(Image.open(f'out_{key}_toon.png'));bg.convert('RGB').resize((w*2,h*2),Image.NEAREST).save(f'prev_{key}_toon.png')
print('ok',edge.sum(),inner.sum())
