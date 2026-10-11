import numpy as np, json, base64
src=open('rigfit.py').read();exec(src.split("P={n:list")[0])
from scipy import ndimage as nd
R=json.load(open('rig.json'));P=R['P']
ORDER=['pyL','pyR','pelvis','uaL','uaR','domeL','domeR','chamber','faL','faR','fistL','fistR','moon']
NAMES={'pyL':'propulsion pylon (left)','pyR':'propulsion pylon (right)','pelvis':'pelvis / hip mass','uaL':'upper arm (left)','uaR':'upper arm (right)','domeL':'shoulder dome — ark (left)','domeR':'shoulder dome — ark (right)',
 'chamber':'barycentric chamber','faL':'forearm (left)','faR':'forearm (right)','fistL':'fist (left)','fistR':'fist (right)','moon':'command moon'}
SD={n:sdf(n,P[n]) for n in ORDER}
inv=~sil;hl,hn=nd.label(inv);hs=nd.sum(inv,hl,range(1,hn+1))
for i,sz in enumerate(hs):
    reg=hl==i+1
    if sz<3000 and not(reg[0,:].any() or reg[-1,:].any() or reg[:,0].any() or reg[:,-1].any()):sil=sil|reg
np.save('rigsil.npy',sil)
# 1) visible owner of every silhouette pixel: the frontmost primitive that contains it, else the nearest one
own=np.full((H,W),-1)
for k,n in enumerate(ORDER):own[(SD[n]<0)&sil]=k
stack=np.stack([SD[n] for n in ORDER]);nearest=stack.argmin(0)
miss=sil&(own<0);own[miss]=nearest[miss]
# 2) each part's matter: everything of its primitive inside the silhouette (hidden parts included, for posing) + the silhouette pixels it owns
prim_iou=None
U=np.zeros((H,W),bool)
for n in ORDER:U|=SD[n]<0
prim_iou=float((U&sil).sum()/(U|sil).sum())
out=[]
for k,n in enumerate(ORDER):
    S=((SD[n]<0)&sil)|(own==k)
    S=nd.binary_fill_holes(S)&sil
    ys,xs=np.where(S);x0,x1,y0,y1=xs.min(),xs.max()+1,ys.min(),ys.max()+1;M=S[y0:y1,x0:x1];h,w=M.shape
    Yl,Xl=np.mgrid[y0:y1,x0:x1].astype(float);p=P[n]
    # the surface each part really has: a dome, a cylinder, a capsule end — so light can find its volume
    if KIND[n]=='ell':
        cx,cy,rx,ry,rot,pw=p;c,s_=np.cos(rot),np.sin(rot);u=((Xl-cx)*c+(Yl-cy)*s_)/rx;v=(-(Xl-cx)*s_+(Yl-cy)*c)/ry
        e=np.clip((np.abs(u)**pw+np.abs(v)**pw)**(1/pw),0,1.2);nzz=np.sqrt(np.clip(1-np.minimum(e,1)**2,0,1))
        gx=u*c-v*s_;gy=u*s_+v*c;nx,ny=gx*.9,gy*.9
        piv=(cx,cy)
    else:
        ax,ay,bx,by,r0,r1=p;dx,dy=bx-ax,by-ay;L2=dx*dx+dy*dy;t=np.clip(((Xl-ax)*dx+(Yl-ay)*dy)/L2,0,1);r=r0+(r1-r0)*t
        qx,qy=Xl-ax-dx*t,Yl-ay-dy*t;d=np.hypot(qx,qy)/np.maximum(r,1);d=np.clip(d,0,1);nx,ny=qx/np.maximum(r,1),qy/np.maximum(r,1);nzz=np.sqrt(np.clip(1-d**2,0,1))
        piv=(ax,ay)
    l=np.sqrt(nx**2+ny**2+nzz**2)+1e-6;nx,ny,nzz=nx/l,ny/l,nzz/l
    dt=nd.distance_transform_edt(M)
    enc=lambda A:base64.b64encode(np.clip(A,0,255).astype(np.uint8).tobytes()).decode()
    joints={}
    if KIND[n]=='cap':joints={'a':[p[0],p[1]],'b':[p[2],p[3]]}
    out.append({'name':n,'label':NAMES[n],'kind':KIND[n],'p':p,'x0':int(x0),'y0':int(y0),'w':int(w),'h':int(h),'pivX':float(piv[0]-x0),'pivY':float(piv[1]-y0),'pg':[float(piv[0]),float(piv[1])],
      'mask':enc(M*1),'vis':enc((own[y0:y1,x0:x1]==k)*1),'nx':enc(nx*120+128),'ny':enc(ny*120+128),'nz':enc(nzz*250),'edge':enc(np.clip(dt,0,255)),'joints':joints,'n':int(M.sum())})
json.dump({'parts':out,'order':ORDER,'primIoU':prim_iou,'hot':[226.7,155.0,36.0],'cold':[181.7,118.3,18.5]},open('rigparts.json','w'))
print('primitive IoU',round(prim_iou,4),[(o['name'],o['n']) for o in out])
