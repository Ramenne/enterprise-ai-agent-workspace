// A user-requested local email preference, never a token or verification code.
const key='qn.pref.member-email';
export function rememberedEmail(storage=localStorage){try{return storage.getItem(key)||'';}catch{return '';}}
export function rememberEmail(email,storage=localStorage){const value=String(email).trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))return;try{storage.setItem(key,value);}catch{}}
