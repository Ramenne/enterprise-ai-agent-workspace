export type TransferProgress={phase:'hash'|'upload'|'verify';loaded:number;total:number};
export type TransferReporter=(stage:string,progress?:TransferProgress)=>void;
