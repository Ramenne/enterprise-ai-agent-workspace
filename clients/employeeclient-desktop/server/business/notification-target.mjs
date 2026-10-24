// One target mapping for inbox, live events and external device delivery.
export function notificationTarget(type,messageId,parentMessageId,projectId){
 const kind=type==='announcement'?'announcement':type==='announcement_reply'?'announcement_reply':type==='legacy_notice'?'legacy_notice':type==='hub_notice'?'hub_update':'chat_message';
 const objectId=kind==='hub_update'?projectId:kind==='announcement_reply'?parentMessageId:messageId;
 const deep_link=kind==='hub_update'?'/business/v1/projects/'+encodeURIComponent(projectId)+'/updates':(kind==='announcement'||kind==='announcement_reply')?'/business/v1/announcements/'+encodeURIComponent(objectId):kind==='chat_message'?'/business/v1/messages/'+encodeURIComponent(messageId):'';
 return {kind,object_type:kind,object_id:objectId,deep_link};
}
