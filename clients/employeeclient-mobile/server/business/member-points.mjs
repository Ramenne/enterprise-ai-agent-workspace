// One narrow authority for balance in own and other member profiles.
export async function readMemberPoints(session,actor){
 const page=await session.rpc('board.member.balance',{member_id:actor});
 if(page.member_id!==actor)throw Object.assign(Error('member_points_identity_mismatch'),{code:'member_points_identity_mismatch',status:502});
 if(typeof page.balance_points!=='number'||!Number.isFinite(page.balance_points)||page.unit!=='point;1 point=1 CNY')throw Object.assign(Error('member_points_invalid'),{code:'member_points_invalid',status:502});
 return {actor_id:actor,balance_points:page.balance_points};
}
