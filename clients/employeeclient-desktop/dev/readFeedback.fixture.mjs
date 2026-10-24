import {ref} from 'vue';import {createReadFeedback} from '../src/domain/readFeedback.mjs';
// Source-model fixtures exercise their own reads; browser tests cover the Vue retry adapter.
export function readFeedbackFixture(){const error=ref('');return {error,feedback:createReadFeedback({publish:text=>error.value=text,setTimer:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;}})};}
