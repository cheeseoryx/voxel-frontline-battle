from PIL import Image, ImageDraw
import numpy as np, json, hashlib
from pathlib import Path
from collections import deque
root=Path(r'F:/voxel-frontline-battle/docs/manhattan-production/evidence')
source=Image.open(root/'community-scale-comparison.png').convert('RGB')
roi=(3650,3260,4350,3730)
a=np.array(source.crop(roi))
yellow=(a[:,:,0]>210)&(a[:,:,1]>205)&(a[:,:,2]<90)
def flood(allowed, sx, sy):
    seen=np.zeros(allowed.shape,dtype=bool)
    if not allowed[sy,sx]: raise ValueError((sx,sy))
    q=deque([(sx,sy)]); seen[sy,sx]=True
    while q:
        x,y=q.popleft()
        for nx,ny in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
            if 0<=nx<allowed.shape[1] and 0<=ny<allowed.shape[0] and allowed[ny,nx] and not seen[ny,nx]:
                seen[ny,nx]=True;q.append((nx,ny))
    return seen
# Locate a boundary stroke near the uppermost bridge-side curve.
ys,xs=np.where(yellow & (np.indices(yellow.shape)[0]<60) & (np.indices(yellow.shape)[1]>150) & (np.indices(yellow.shape)[1]<300))
boundary=flood(yellow,int(xs[0]),int(ys[0]))
yy,xx=np.where(boundary)
outside=flood(~boundary,0,0)
total=~outside
central=flood(~boundary,350,250)
# HQ interior seeds; excludes line thickness, flags are not part of connected boundary.
hq1=flood(~boundary,150,150)
hq2=flood(~boundary,600,360)
# Flags hand-read from full-resolution comparison ROI (3650,3000,800,850).
world=np.array([[254,493],[381,386],[365,500],[367,606],[491,500]],dtype=float)
# Hand-read centres in the EA deployment screenshot displayed at 1600 x 900.
screen=np.array([[660,428],[818,294],[800,438],[803,569],[959,438]],dtype=float)
X=np.column_stack((world[:,0],-world[:,1],np.ones(5),np.zeros(5)))
Y=np.column_stack((world[:,1],world[:,0],np.zeros(5),np.ones(5)))
params=np.linalg.lstsq(np.vstack((X,Y)),np.concatenate((screen[:,0],screen[:,1])),rcond=None)[0]
aa,bb,tx,ty=params
pred=np.column_stack((aa*world[:,0]-bb*world[:,1]+tx,bb*world[:,0]+aa*world[:,1]+ty))
sc=float(np.hypot(aa,bb))
p=[(75,430),(80,367),(90,362),(128,362),(160,325),(181,308),(202,298),(223,296),(246,300),(316,326),(427,321),(435,329),(432,338),(452,338),(455,419),(537,420),(538,434),(550,434),(550,442),(560,444),(560,457),(568,460),(568,546),(585,550),(592,560),(631,562),(632,579),(646,582),(646,642),(618,643),(621,694),(329,694),(322,680),(319,668),(318,639),(302,639),(296,626),(290,621),(290,597),(236,596),(232,571),(220,571),(219,530),(148,533),(145,508),(138,505),(136,430)]
poly_area=abs(sum(p[i][0]*p[(i+1)%len(p)][1]-p[(i+1)%len(p)][0]*p[i][1] for i in range(len(p))))/2
# Corresponding screen overlay vertices; no editing of source pixels.
official_polygon=[[round(aa*x-bb*y+tx,2),round(bb*x+aa*y+ty,2)] for x,y in p]
result={
 'source_image_dimensions_px':source.size,'official_image_dimensions_px':Image.open(root/'ea-olympia-conquest.png').size,
 'roi_xyxy_px':roi,'assumed_m_per_px':1,'assumption_origin':'Author HUD-calibrated diagram; 100px grid = 100m. Raw paired HUD calibration not independently verified.',
 'yellow_threshold_rgb':'R>210,G>205,B<90','boundary_bbox_in_roi_px':[int(xx.min()),int(yy.min()),int(xx.max()),int(yy.max())],
 'bbox_inclusive_px':[int(xx.max()-xx.min()+1),int(yy.max()-yy.min()+1)],
 'total_with_border_px2':int(total.sum()),'all_interiors_without_border_px2':int(total.sum()-boundary.sum()),
 'central_without_border_px2':int(central.sum()),'hq1_without_border_px2':int(hq1.sum()),'hq2_without_border_px2':int(hq2.sum()),
 'manual_polygon_centerline_area_px2':poly_area,
 'landmarks_order':['A','B','C','D','E'],'landmarks_comparison_crop_px':world.tolist(),'landmarks_ea_display_1600x900_px':screen.tolist(),
 'fitted_ea_px_per_m':sc,'fitted_rotation_degrees':float(np.degrees(np.arctan2(bb,aa))),
 'landmark_rms_residual_px':float(np.sqrt(np.mean(np.sum((screen-pred)**2,axis=1)))),
 'baselines_m':{'A_C':float(np.linalg.norm(world[0]-world[2])),'C_E':float(np.linalg.norm(world[2]-world[4])),'B_D':float(np.linalg.norm(world[1]-world[3])),'A_E':float(np.linalg.norm(world[0]-world[4]))},
 'manual_polygon_comparison_crop_px':p,'official_overlay_polygon_1600x900_px':official_polygon,
 'sha256':{f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in ['community-scale-comparison.png','ea-olympia-conquest.png']}
}
(root/'measurement-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if 'polygon' not in k and 'sha256' not in k},ensure_ascii=False,indent=2))
