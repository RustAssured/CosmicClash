# the final rig: anatomical parts, their pixels read from the reference where it shows them, built procedurally where it doesn't
import numpy as np, json, base64
from scipy import ndimage as nd
from PIL import Image
R=json.load(open('rigparts.json'));sil=np.load('rigsil.npy');H,W=sil.shape
im=np.array(Image.open('../../reference/uri_front_reference.png').convert('RGB')).astype(float);r,g,b=im[...,0],im[...,1],im[...,2];lum=r*.3+g*.59+b*.11
L1=nd.gaussian_filter(lum,.55);L3=nd.gaussian_filter(lum,3.0);L8=nd.gaussian_filter(lum,8.0)
warmE=(r>165)&(r-b>65)&(lum>115);blueE=(b>140)&(b-r>22)&(lum>80);crev=(L1<22)&(L1<L8*.6);rimhi=(L1>L3*1.35)&(L1>90)
dec=lambda s:np.frombuffer(base64.b64decode(s),np.uint8)
def vnoise(h,w,s,seed):
    gg=np.random.default_rng(seed).random((h//s+3,w//s+3));return np.array(Image.fromarray((gg*255).astype(np.uint8)).resize((gg.shape[1]*s,gg.shape[0]*s),Image.BICUBIC))[:h,:w]/255.
def fbm(h,w,seed,sc=(8,4,2)):
    t=np.zeros((h,w));a=1;n=0
    for s in sc:t+=a*vnoise(h,w,s,seed+s);n+=a;a*=.5
    return t/n
from scipy.spatial import cKDTree
out=[]
for k,p in enumerate(R['parts']):
    h,w,x0,y0=p['h'],p['w'],p['x0'],p['y0'];M=dec(p['mask']).reshape(h,w).astype(bool);V=dec(p['vis']).reshape(h,w).astype(bool)&M
    nx0=(dec(p['nx']).reshape(h,w)-128)/120.;ny0=(dec(p['ny']).reshape(h,w)-128)/120.;nz0=dec(p['nz']).reshape(h,w)/250.
    sl=lambda A:A[y0:y0+h,x0:x0+w];sd=101+k*13
    F=fbm(h,w,sd);Ff=fbm(h,w,sd+3,(3,2));dt=nd.distance_transform_edt(M)
    # light the primitive from the reference's light, so hidden pixels get a believable form
    LS=np.array([-.55,-.62,.56]);LS/=np.linalg.norm(LS);dkp=np.clip(nx0*LS[0]+ny0*LS[1]+nz0*LS[2],0,1)
    formV=np.clip(sl(L1)/max(1,np.percentile(sl(L1)[V],98)) if V.any() else dkp,0,1)
    formH=np.clip(.1+.5*dkp+(F-.5)*.3,0,1)
    form=np.where(V,formV,formH)
    # materials: from the reference where visible; procedural slabs, seams and specks where hidden
    mat=np.zeros((h,w),np.uint8);mat[M]=1
    mat[V&sl(crev)]=10;mat[V&sl(warmE)]=3;mat[V&sl(blueE)]=2
    rr=np.random.default_rng(sd);hid=M&~V
    sx=fbm(h,w,sd+7,(6,3));seam=hid&(np.abs(sx-.5)<.03);mat[seam]=10;mat[hid&(rr.random((h,w))<.006)]=3
    if p['name'].startswith('py'):Yl=np.mgrid[0:h,0:w][0];mat[M&(Yl>h*.7)&(rr.random((h,w))<.05)]=2
    if p['name']=='moon':Yl,Xl=np.mgrid[0:h,0:w];mat[M&(np.abs(Yl-h/2)<1)&(np.abs(Xl-w/2)<w*.3)]=9
    warmside=np.clip((sl(r)-sl(b))/60,-1,1)>.05;avgwarm=warmside[V].mean() if V.any() else .5
    surf=np.where(V,np.where(warmside,1,2),np.where(avgwarm>.5,1,2)).astype(np.uint8)
    tone=np.clip(.5+(Ff-.5)*.25+np.where(V,sl(rimhi)*.25,0),0,1)
    # normals: the part's true geometry, bent by the reference's own relief
    hg=np.where(M,form*2.0+np.clip(dt/12,0,1)**.5*1.2+Ff*.3,0);gy,gx=np.gradient(nd.gaussian_filter(hg,.8))
    nx=nx0*.6-gx*1.6;ny=ny0*.6-gy*1.6;nz=nz0*.6+.6;l=np.sqrt(nx**2+ny**2+nz**2)+1e-6;nx,ny,nz=nx/l,ny/l,nz/l
    # chunks: how this part breaks — irregular pieces, bigger in the big masses
    cs={'chamber':11,'domeL':11,'domeR':11}.get(p['name'],8)
    rg=np.random.default_rng(sd+1);npts=max(4,int(M.sum()/(cs*cs)));ys,xs=np.where(M);ii=rg.choice(len(xs),npts,replace=False);pts=np.stack([ys[ii],xs[ii]],1)
    Yl,Xl=np.mgrid[0:h,0:w];_,cid=cKDTree(pts).query(np.stack([Yl.ravel()+(fbm(h,w,sd+9,(6,3)).ravel()-.5)*6,Xl.ravel()],1));cid=cid.reshape(h,w)
    # hidden faces get the same language as the visible ones: plates split along the break lines, darker crevices
    bnd=np.zeros((h,w),bool)
    for dy_,dx_ in[(0,1),(1,0)]:sh=np.roll(np.roll(cid,dy_,0),dx_,1);bnd|=(sh!=cid)
    mat[hid&bnd&(rg.random((h,w))<.75)&(mat==1)]=10
    tone=np.where(hid,np.clip(tone-.12+(fbm(h,w,sd+12,(4,2))-.5)*.4,0,1),tone)
    enc=lambda A:base64.b64encode(np.clip(A,0,255).astype(np.uint8).tobytes()).decode()
    enc16=lambda A:base64.b64encode(A.astype('<u2').tobytes()).decode()
    q=dict(p);q.update({'mat':enc(mat),'surf':enc(surf),'tone':enc(tone*255),'form':enc(form*255),'nx':enc(nx*120+128),'ny':enc(ny*120+128),'nz':enc(nz*250),'edge':enc(np.clip(dt,0,255)),'chunk':enc16(cid),'nchunk':int(npts)})
    for kk in('mask','vis'):q.pop(kk,None)
    out.append(q)
json.dump({'parts':out,'order':R['order'],'hot':R['hot'],'cold':R['cold'],'primIoU':R['primIoU']},open('finalrig.json','w'))
print([(o['name'],o['nchunk']) for o in out])
