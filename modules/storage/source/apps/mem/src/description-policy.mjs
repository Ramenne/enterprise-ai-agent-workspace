/** A writing contract, not an assertion that a model has understood the original. */
export const descriptionPolicy={version:'agent-description-v1',author:'Agent_or_member',source:'read_the_fixed_original;declare_partial_coverage_when_incomplete',fields:['材料主题与类型','主要内容或结论','用途与可回答的问题','适用范围、时点和必要局限'],recommended_length:'通常80至250汉字，短材料可更短；最终以嵌入模型实际长度检查为准',prohibitions:['不编造原文未包含的主题、结论或采用关系','不堆砌特定查询的关键词','不同主题不能复制相同套话','不能只写登记、上传或保存状态'],coverage:'简介用于文件发现；原文读取另行进行',indexing:'active简介保存后按现有资格自动尝试索引；失败保留已保存简介与原幂等结果，明确返回维护状态，不阻塞原件'};
export function inspectDescription(body){
 const text=body.text.trim();
 if(body.state==='active'&&(!text||/^(?:已登记|已上传|已保存|登记完成|上传完成|保存完成|暂无简介|待补充|测试|test)[。.!！\s]*$/iu.test(text)))return{valid:false,error_code:'description_content_required'};
 const warnings=[];
 if(text.length<40)warnings.push('brief_description_check_topic_and_use');
 if(text.length>800)warnings.push('long_description_may_need_condense');
 return{valid:true,warnings,policy_version:descriptionPolicy.version};
}
