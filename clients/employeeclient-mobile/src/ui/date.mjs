// Display only: keep actual timestamps, storage identifiers and device timezone.
export function fullDate(value) {
 if(value==null||value==='')return '';
 const date=value instanceof Date?value:new Date(value);
 return Number.isFinite(date.getTime())?`${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()}`:'';
}
export function fullDateTime(value) {
 const date=value instanceof Date?value:new Date(value),label=fullDate(value);
 return label?`${label} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`:'';
}
