import {galleryTools as baseTools} from './gallery-contract.mjs';
import {galleryLoopTools} from './gallery-loop-contract.mjs';
export const galleryTools=[...baseTools,...galleryLoopTools];
export const galleryRoute=name=>galleryLoopTools.some(t=>t.name===name)?'/visual-lab/api/loop/'+encodeURIComponent(name):'/visual-lab/api/tools/'+name.slice('gallery.'.length);
