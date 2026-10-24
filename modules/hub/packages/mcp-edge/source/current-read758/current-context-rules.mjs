/** Present current collaboration rules; business data remains separate. */
export function currentContextRules(data){
 return {...data,rules:{
  '执行':'使用本人当前身份与真实资格，按明确任务范围自主推进；职责完整规则见service-boundary。',
  '留存':'原文、报告和成果分别保留，阶段记录沿已有工作追加，覆盖与未知如实说明。',
  '资料':'固定版本保持原引用；缺简介或未评关联不阻塞获准存取。',
  '判断':'分类、关联、重要性与采用由成员和Agent判断，保留依据及不确定性。',
  '工程':'维护权威源码，使用中持续改进；检查以当前变更及实际问题为范围。',
  '历史':'历史规则与记录通过正式档案读取，不参与现行规则覆盖计算。'
 }};
}
