const stamp=row=>Number(row.created_at)||0;
const seq=row=>Number(row.message_seq)||0;
export function orderGroupFiles(rows){
 const files=new Map();
 for(const row of rows){const old=files.get(row.id);if(!old||stamp(row)>stamp(old)||stamp(row)===stamp(old)&&seq(row)>seq(old))files.set(row.id,row);}
 return [...files.values()].sort((a,b)=>stamp(b)-stamp(a)||seq(b)-seq(a));
}
