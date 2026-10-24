/** The complete role policy is the current published manual, not a copy in code. */
export const serviceProviderBoundary=Object.freeze({id:'service_provider_boundary',kind:'role_policy',manual:{id:'service-boundary',system:'hufu',method:'POST',path:'/v2/manuals/read',body:{id:'service-boundary'}},authority:'current_user_assignment_and_actual_service_permissions'});
export function withServiceProviderBoundary(data){
 return {...data,role_policy:serviceProviderBoundary};
}
