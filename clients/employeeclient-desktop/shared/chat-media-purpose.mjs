import {effectiveKind} from './file-type.mjs';
// Explicit purpose is authoritative. Older recorder files use an exact legacy name.
// Audio uploaded as a normal file remains a file, not a voice chat message.
export function isVoiceMessage(a){
 if(a?.purpose)return a.purpose==='voice';
 return /^audio\//i.test(a?.mime||'')&&/^语音-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.(webm|m4a)$/.test(a?.name||'');
}

export function isGroupFile(a){return !isVoiceMessage(a)&&effectiveKind(a?.name||'',a?.mime)!=='image';}
