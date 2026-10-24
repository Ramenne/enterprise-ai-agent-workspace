export function verificationMailGateway(endpoint:string,token:string):(data:{user:{email:string};url:string;token:string})=>Promise<void>;

export function otpMailGateway(endpoint:string,token:string,sender?:string):(data:{email:string;otp:string;type:'sign-in'|'email-verification'|'forget-password'})=>Promise<void>;
