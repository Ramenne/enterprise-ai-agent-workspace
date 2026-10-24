<script setup lang="ts">
const emit=defineEmits<{choose:[value:string];close:[]}>();
const emojis=[['😀','开心'],['😂','大笑'],['😊','微笑'],['😉','眨眼'],['🥰','喜爱'],['😍','喜欢'],['🤔','思考'],['😅','汗笑'],['😎','酷'],['😭','哭泣'],['😢','难过'],['😮','惊讶'],['😴','困了'],['🤗','拥抱'],['🥳','庆祝'],['😇','天使'],['👍','赞'],['👎','不赞'],['👏','鼓掌'],['🙏','感谢'],['👌','好的'],['🤝','握手'],['💪','加油'],['👋','挥手'],['❤️','爱心'],['💐','花束'],['🎉','礼花'],['🎂','生日蛋糕'],['✅','完成'],['☕','咖啡'],['🔥','火'],['✨','闪亮']];
</script>
<template><section class="emoji-picker" aria-label="表情面板"><header><span>表情</span><button @click="emit('close')">返回键盘</button></header><div><button v-for="[value,label] in emojis" :key="value" :aria-label="'插入表情：'+label" @pointerdown.prevent @click="emit('choose',value)">{{value}}</button></div></section></template>
<style scoped>
.emoji-picker{padding:8px 0}.emoji-picker header{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:6px}.emoji-picker header button{border:0;background:transparent;color:#4c6485;min-height:36px}.emoji-picker>div{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));max-height:180px;overflow-y:auto}.emoji-picker>div button{border:0;background:transparent;min-height:40px;font-size:24px;padding:4px 0}.emoji-picker>div button:active{background:var(--green-soft);border-radius:6px}
</style>
