import type {FastifyInstance} from 'fastify';
import type pg from 'pg';
import {createHash} from 'node:crypto';
import {projectPrivacySchemas} from './project-privacy-contracts.js';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sqlFunction} from '../../../packages/platform/src/db.js';

export function installProjectPrivacy(app:FastifyInstance,pool:pg.Pool){
 app.get('/v2/projects/privacy/help',async()=>({version:'project-policy-20261007',classifications:['team','personal','private'],default_read:'current_organization_members_for_team_and_personal;credential_restrictions_still_apply',creation:{default:'personal',team:'actual_organization_supervisor_only;new_or_promote_personal',private:'owner_marks_an_existing_project_via_v8.project.convert'},privacy:{owner:'retains_own_work_access',others:'actual_owner_and_actual_organization_supervisor_approve_same_request',supervisor_has_automatic_read:false,classification_control:'actual_owner_only_when_entering_or_leaving_private',same_actor_holds_both_roles:'two_explicit_legs_allowed_only_when_current_actor_is_both_actual_owner_and_supervisor',old_qualifications:'do_not_bypass_privacy',read_approval_grants_write:false,software:'owner_may_invite_specific_service;both_human_roles_still_required'},workflow:{apply:'/v2/projects/privacy/apply',requests:'/v2/projects/privacy/requests',decide:'/v2/projects/privacy/decide',revoke:'/v2/projects/privacy/revoke',decision_leg:['owner','supervisor'],expiry:'explicit_expires_at_or_until_revoked;default_until_revoked',scope_change:'old_consent_does_not_reactivate'},request_metadata:'role_authorization_queue;no_private_project_contents'}));
 for(const [command,schema] of Object.entries(projectPrivacySchemas))app.post('/v2/projects/privacy/'+command,{logLevel:'silent'},async request=>{
  const parsed=schema.safeParse(request.body??{});if(!parsed.success)throw new DomainError('invalid_input',400);
  return sqlFunction(pool,'authz.project_privacy_api',[createHash('sha256').update(bearer(request)).digest('hex'),command,parsed.data]);
 });
}
