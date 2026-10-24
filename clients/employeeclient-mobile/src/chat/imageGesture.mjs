export function createImageGesture(){
 let state={scale:1,x:0,y:0},geometry={width:1,height:1,viewportWidth:1,viewportHeight:1},baseline;const points=new Map();
 const snapshot=()=>({...state});
 // Keep a recoverable part visible, while allowing dragging at every zoom level.
 function clamp(){const maxX=Math.max(0,(geometry.width*state.scale+geometry.viewportWidth)/2-Math.min(48,geometry.width*state.scale)),maxY=Math.max(0,(geometry.height*state.scale+geometry.viewportHeight)/2-Math.min(48,geometry.height*state.scale));state.x=Math.max(-maxX,Math.min(maxX,state.x));state.y=Math.max(-maxY,Math.min(maxY,state.y));}
 const midpoint=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
 function rebase(){const p=[...points.values()];baseline=p.length>1?{point:midpoint(p[0],p[1]),distance:Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y),...state}:p.length?{point:p[0],...state}:null;}
 function configure(next){if(Object.values(next).every(v=>Number.isFinite(v)&&v>0)){geometry=next;clamp();rebase();}return snapshot();}
 function begin(id,point){points.set(id,point);rebase();return snapshot();}
 function move(id,point){if(!points.has(id))return snapshot();points.set(id,point);const p=[...points.values()];if(!baseline)return snapshot();
  if(p.length>1){const mid=midpoint(p[0],p[1]),distance=Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y);state.scale=Math.max(0.25,Math.min(5,baseline.scale*distance/Math.max(1,baseline.distance)));state.x=mid.x-(baseline.point.x-baseline.x)*state.scale/baseline.scale;state.y=mid.y-(baseline.point.y-baseline.y)*state.scale/baseline.scale;}
  else{state.x=baseline.x+point.x-baseline.point.x;state.y=baseline.y+point.y-baseline.point.y;}clamp();return snapshot();
 }
 function end(id){points.delete(id);rebase();return snapshot();}
 function zoomTo(scale,point={x:0,y:0}){const next=Math.max(0.25,Math.min(5,scale)),ratio=next/state.scale;state.x=point.x-(point.x-state.x)*ratio;state.y=point.y-(point.y-state.y)*ratio;state.scale=next;clamp();rebase();return snapshot();}
 function reset(){points.clear();state={scale:1,x:0,y:0};rebase();return snapshot();}
 return {configure,begin,move,end,zoomTo,reset,snapshot};
}
