# From reference art to `uri_rig.json`
Run inside this folder, in order (Python 3, numpy, scipy, Pillow). Intermediate files land here.
1. `1_segment_reference.py` — silhouette mask + rough part regions from `reference/uri_front_reference.png` → `mask.npy`, `lbl.npy`
2. `2_reference_structure.py` — reads the reference's structure (form light, crevices, lights) and writes the rest silhouette → `finalsil.npy`
3. `3_fit_primitives.py` — fits 13 anatomical primitives (domes, capsules) to the silhouette within anatomical bounds → `rig.json`
4. `4_conform_parts.py` — fills interior shadows, conforms each part's outer edge to the reference outline (100% overlap), computes primitive normals → `rigparts.json`, `rigsil.npy`
5. `5_dress_parts.py` — dresses each part: reference-derived matter where visible, procedural matter where hidden, normals, chunks → `finalrig.json` (= `data/uri_rig.json`)
Re-run from step 3 if the anatomy needs adjusting; from step 5 for material changes only.
