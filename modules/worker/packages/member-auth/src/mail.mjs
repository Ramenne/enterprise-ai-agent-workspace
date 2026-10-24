/** A configured HTTPS delivery gateway receives only the target and verification link.
 * Its 2xx response must mean queued real delivery, never local fixture success. */
export function verificationMailGateway(endpoint,token){
 const url=new URL(endpoint);if(url.protocol!=='https:'||!token)throw new Error('verification_mail_gateway_https_required');
 return async({user,url:verificationURL})=>{
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({to:user.email,template:'hub2-member-verification',verification_url:verificationURL}),signal:AbortSignal.timeout(10000)});
  await response.body?.cancel();if(!response.ok)throw new Error('verification_email_delivery_unavailable');
 };
}

/** A 2xx means the configured provider accepted real delivery; never log OTPs. */
export function otpMailGateway(endpoint,token,sender='notify@service.example.invalid'){
 const url=new URL(endpoint);if(url.protocol!=='https:'||url.username||url.password||!token||sender!=='notify@service.example.invalid')throw new Error('otp_mail_gateway_configuration_invalid');
 return async({email,otp,type})=>{
  if(!/^\d{6}$/.test(otp)||!['sign-in','email-verification','forget-password'].includes(type))throw new Error('otp_mail_payload_invalid');
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({from:sender,to:email,template:'hub2-member-email-otp',otp,type,expires_in:300}),signal:AbortSignal.timeout(10000)});
  await response.body?.cancel();if(!response.ok)throw new Error('email_otp_delivery_unavailable');
 };
}
