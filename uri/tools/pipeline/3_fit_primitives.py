# fit an anatomical rig of primitives to the reference silhouette
import numpy as np, json, time
sil=np.load('finalsil.npy');H,W=sil.shape;Y,X=np.mgrid[0:H,0:W].astype(np.float32)
def ell(p):  # cx,cy,rx,ry,rot,pw
    cx,cy,rx,ry,rot,pw=p;c,s=np.cos(rot),np.sin(rot);u=((X-cx)*c+(Y-cy)*s)/max(rx,1);v=(-(X-cx)*s+(Y-cy)*c)/max(ry,1)
    return (np.abs(u)**pw+np.abs(v)**pw)**(1/pw)-1
def cap(p):  # ax,ay,bx,by,r0,r1
    ax,ay,bx,by,r0,r1=p;dx,dy=bx-ax,by-ay;L2=dx*dx+dy*dy+1e-6;t=np.clip(((X-ax)*dx+(Y-ay)*dy)/L2,0,1);r=r0+(r1-r0)*t
    return (np.hypot(X-ax-dx*t,Y-ay-dy*t)-r)/np.maximum(r,1)
KIND={'moon':'ell','domeL':'ell','domeR':'ell','chamber':'ell','pelvis':'ell','fistL':'ell','fistR':'ell','uaL':'cap','faL':'cap','uaR':'cap','faR':'cap','pyL':'cap','pyR':'cap'}
P0={'moon':[190,26,13,13,0,2],'domeL':[90,102,60,46,-.15,2.3],'domeR':[298,92,70,52,.18,2.3],'chamber':[205,152,78,68,0,2.4],'pelvis':[200,218,50,22,0,2.4],
 'uaL':[55,140,28,195,26,24],'faL':[30,200,70,245,28,30],'fistL':[78,272,44,40,.3,2.6],
 'uaR':[345,140,372,192,26,24],'faR':[370,198,332,246,28,30],'fistR':[325,272,46,40,-.3,2.6],
 'pyL':[140,215,138,312,24,6],'pyR':[247,222,250,314,26,6]}
LO={};HI={}
for n,v in P0.items():
    if KIND[n]=='ell':LO[n]=[v[0]-12,v[1]-12,v[2]*.8,v[3]*.8,v[4]-.3,2.0];HI[n]=[v[0]+12,v[1]+12,v[2]*1.2,v[3]*1.2,v[4]+.3,3.2]
    else:LO[n]=[v[0]-12,v[1]-12,v[2]-12,v[3]-12,v[4]*.75,v[5]*.75];HI[n]=[v[0]+12,v[1]+12,v[2]+12,v[3]+12,v[4]*1.25,v[5]*1.25]
names=list(P0)
def sdf(n,p):return ell(p) if KIND[n]=='ell' else cap(p)
def score(masks,P):
    U=np.zeros((H,W),bool)
    for n in names:U|=masks[n]
    inter=(U&sil).sum();uni=(U|sil).sum();iou=inter/uni
    pen=0
    for s in'LR':  # the chain must stay connected: shoulder in the dome, elbow shared, wrist into the fist
        ua,fa,fi=P['ua'+s],P['fa'+s],P['fist'+s]
        pen+=np.hypot(ua[2]-fa[0],ua[3]-fa[1])/40+max(0,np.hypot(fa[2]-fi[0],fa[3]-fi[1])-fi[2]*.6)/40
        dm=P['dome'+s];pen+=max(0,np.hypot(ua[0]-dm[0],ua[1]-dm[1])-dm[2]*.9)/60
    for s in'LR':
        py=P['py'+s];pv=P['pelvis'];pen+=max(0,np.hypot(py[0]-pv[0],py[1]-pv[1])-pv[2]*1.1)/80
    return iou-pen*.05,iou
P={n:list(map(float,v)) for n,v in P0.items()};masks={n:sdf(n,P[n])<0 for n in names}
best,biou=score(masks,P);print('start',round(biou,4))
rng=np.random.default_rng(1);T0=time.time()
step={'ell':[3,3,3,3,.05,.15],'cap':[3,3,3,3,2,2]}
for it in range(7000):
    n=names[rng.integers(len(names))];k=KIND[n];old=P[n][:];j=rng.integers(6)
    temp=max(.15,1-it/7000)
    P[n][j]+=rng.normal()*step[k][j]*temp
    P[n][j]=min(HI[n][j],max(LO[n][j],P[n][j]))
    om=masks[n];masks[n]=sdf(n,P[n])<0;sc,iou=score(masks,P)
    if sc>=best:best,biou=sc,iou
    else:P[n]=old;masks[n]=om
    if it%1500==0:print(it,round(biou,4),round(time.time()-T0,1))
print('fit IoU',round(biou,4))
json.dump({'P':P,'kind':KIND,'iou':biou},open('rig.json','w'))
