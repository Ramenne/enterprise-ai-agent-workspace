export function restoredRoute(value){
 return typeof value==='string'&&/^\/(?!\/)/.test(value)&&!/^\/connect(?:[?#]|$)/.test(value)?value:'/messages';
}
