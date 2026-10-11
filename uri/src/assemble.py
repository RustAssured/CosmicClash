# rebuilds the locked demo from the modules:  python3 src/assemble.py  →  build/uri.html
import json,os
here=os.path.dirname(os.path.abspath(__file__));root=os.path.dirname(here)
rig=json.load(open(os.path.join(root,'data','uri_rig.json')))
js=''.join(open(os.path.join(here,f)).read() for f in['10_parts_render.js','20_kinetics.js','30_breaking_compose.js'])+'\n'+open(os.path.join(here,'40_page_ui.js')).read()
js=js.replace('__RIG__',json.dumps(rig)).replace('__REFIMG__','').replace('__REFSIL__','')
os.makedirs(os.path.join(root,'build'),exist_ok=True)
open(os.path.join(root,'build','uri.html'),'w').write(open(os.path.join(here,'page_head.html')).read()+open(os.path.join(here,'00_shared_helpers.js')).read()+js)
print('built build/uri.html')
