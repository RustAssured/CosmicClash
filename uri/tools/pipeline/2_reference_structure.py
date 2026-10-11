# 우리, final: the reference silhouette exactly, its structure read from the reference, built up in pixel matter
import numpy as np, json, base64
from scipy import ndimage as nd
from PIL import Image
lbl=np.load('lbl.npy');m=np.load('mask.npy');H,W=m.shape
names=['moon','fistL','fistR','armL','armR','pyL','pyR','arkL','arkR','chamber']
HOT=(226.7,155.0,36.0);COLD=(181.7,118.3,18.5)
im=np.array(Image.open('../../reference/uri_front_reference.png').convert('RGB')).astype(float)
r,g,b=im[...,0],im[...,1],im[...,2];lum=r*.3+g*.59+b*.11
yy,xx=np.mgrid[0:H,0:W]
incore=(np.hypot(xx-HOT[0],yy-HOT[1])<HOT[2])|(np.hypot(xx-COLD[0],yy-COLD[1])<COLD[2])
sil=m|incore
# the structure of the reference, read at several scales
L1=nd.gaussian_filter(lum,.55);L3=nd.gaussian_filter(lum,3.0);L8=nd.gaussian_filter(lum,8.0)
crev=(L1<22)&(L1<L8*.6)                    # deep crevices: much darker than their surroundings
rimhi=(L1>L3*1.35)&(L1>90)                 # edges catching light
warmE=(r>165)&(r-b>65)&(lum>115);blueE=(b>140)&(b-r>22)&(lum>80)
hue=np.clip((r-b)/60,-1,1)                 # warm-lit vs cool-lit faces in the reference
rng=np.random.default_rng(3)
def vnoise(h,w,s,seed):
    gg=np.random.default_rng(seed).random((h//s+3,w//s+3));return np.array(Image.fromarray((gg*255).astype(np.uint8)).resize((gg.shape[1]*s,gg.shape[0]*s),Image.BICUBIC))[:h,:w]/255.
def fbm(h,w,seed,scales=(8,4,2)):
    t=np.zeros((h,w));a=1;n=0
    for s in scales:t+=a*vnoise(h,w,s,seed+s);n+=a;a*=.5
    return t/n
# the seams where one body meets the next: they stay inside the silhouette, as crevices with force in them
seamAll=np.zeros((H,W),bool)
for dy,dx in[(0,1),(1,0),(1,1),(1,-1)]:
    sh=np.roll(np.roll(lbl,dy,0),dx,1);seamAll|=(lbl>0)&(sh>0)&(sh!=lbl)
out=[]
for k,nm in enumerate(names):
    sel=(lbl==k+1)&m
    ys,xs=np.where(sel);x0,x1,y0,y1=xs.min(),xs.max()+1,ys.min(),ys.max()+1;S=sel[y0:y1,x0:x1];h,w=S.shape
    sl=lambda A:A[y0:y1,x0:x1]
    dt=nd.distance_transform_edt(S);sd=11+k*17
    F=fbm(h,w,sd);Ff=fbm(h,w,sd+5,(3,2))
    # height: the reference's own form (smoothed light), a bevel at the true silhouette, the micro-relief of each material
    form=sl(L3)/max(1,np.percentile(sl(L3)[S],97));formf=sl(L1)/max(1,np.percentile(sl(L1)[S],98))
    hgt=np.clip(dt/14,0,1)**.5*2.2+form*2.4+formf*.9+Ff*.35
    mat=np.zeros((h,w),np.uint8);mat[S]=1
    cv=S&sl(crev);mat[cv]=10
    mat[S&sl(warmE)]=3;mat[S&sl(blueE)]=2
    mat[S&sl(seamAll)&~sl(warmE)]=10;mat[S&sl(seamAll)&(rng.random((h,w))<.12)]=2
    if nm=='chamber':
        mat[S&sl(incore)]=0
        Y,X=np.mgrid[0:h,0:w];cx,cy=HOT[0]-x0,HOT[1]-y0;qx,qy=COLD[0]-x0,COLD[1]-y0
        fr=(np.abs(np.hypot(X-cx,Y-cy)-HOT[2]-4)<1.6)|(np.abs(np.hypot(X-qx,Y-qy)-COLD[2]-3)<1.3)
        mat[S&fr&(mat==1)]=13;mat[S&(mat==1)&(sl(L3)<45)]=12
        riv=S&fr&((X+Y)%5==0);mat[riv]=15
    if nm.startswith('py'):
        Y=np.mgrid[0:h,0:w][0];mat[S&(mat==1)&(Y>h*.55)&(sl(b)>sl(r)+10)]=13
    if nm=='moon':
        Y,X=np.mgrid[0:h,0:w];mat[S&(np.abs(Y-h/2)<1)&(np.abs(X-w/2)<w*.3)]=9
    thin=S&(dt<=1.5)&(np.mgrid[0:h,0:w][0]<h*.4)&(mat==1)
    if nm in('arkL','arkR','chamber'):mat[thin]=6
    surf=np.where(sl(hue)[...]>.05,1,2).astype(np.uint8)  # warm-lit or cool-lit rock, per pixel, as in the reference
    tone=np.clip(.5+(F-.5)*.2+sl(rimhi)*.25,0,1)
    gy,gx=np.gradient(nd.gaussian_filter(np.where(S,hgt,0),.8));nx=-gx*2.4;ny=-gy*2.4;nz=np.ones_like(nx);l=np.sqrt(nx**2+ny**2+nz**2);nx/=l;ny/=l;nz/=l
    ao=np.clip(dt/7,0,1)**.6
    piv=(xs.mean()-x0,ys.mean()-y0)
    if nm in('armL','armR','fistL','fistR','pyL','pyR'):tp=ys<ys.min()+8;piv=(xs[tp].mean()-x0,ys.min()-y0)
    enc=lambda A:base64.b64encode(np.clip(A,0,255).astype(np.uint8).tobytes()).decode()
    out.append({'name':nm,'x0':int(x0),'y0':int(y0),'w':int(w),'h':int(h),'px':float(piv[0]),'py':float(piv[1]),'cx':float(piv[0]+x0),'cy':float(piv[1]+y0),
      'mat':enc(mat),'surf':enc(surf),'tone':enc(tone*255),'form':enc(np.clip(formf,0,1)*255),'nx':enc(nx*120+128),'ny':enc(ny*120+128),'nz':enc(nz*250),'ao':enc(ao*255),'n':int(S.sum())})
json.dump({'parts':out,'hot':HOT,'cold':COLD},open('final.json','w'))
np.save('finalsil.npy',sil)
print('parts',[(o['name'],o['n']) for o in out],'sil',int(sil.sum()),'union',int(m.sum()))
