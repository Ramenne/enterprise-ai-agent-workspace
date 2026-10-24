import {effectiveMime as mimeOf,effectiveKind as kindOf} from '../../shared/file-type.mjs';
export function effectiveMime(name:string,mime?:string):string{return mimeOf(name,mime);}
export function effectiveKind(name:string,mime?:string):'image'|'video'|'audio'|'file'{return kindOf(name,mime);}
