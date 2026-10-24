<script setup lang="ts">
import {computed} from 'vue';
import {messageTextParts} from '../../../shared/chat-search.mjs';
const props=defineProps<{text:string;query?:string}>();
const parts=computed(()=>messageTextParts(props.text,props.query||''));
</script>
<template><p><template v-for="(part,index) in parts" :key="index"><a v-if="part.href" :href="part.href" target="_blank" rel="noopener noreferrer" @click.stop @dblclick.stop @contextmenu.stop><template v-for="(chunk,i) in part.parts" :key="i"><mark v-if="chunk.match">{{chunk.text}}</mark><template v-else>{{chunk.text}}</template></template></a><template v-else><template v-for="(chunk,i) in part.parts" :key="i"><mark v-if="chunk.match">{{chunk.text}}</mark><template v-else>{{chunk.text}}</template></template></template></template></p></template>
<style scoped>
p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}a{color:#4c6485;text-decoration:underline;text-underline-offset:2px}mark{background:#f4e4a0;color:inherit;border-radius:2px}
</style>
