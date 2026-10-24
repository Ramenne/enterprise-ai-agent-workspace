<script setup lang="ts">
import {useUiStore} from '@/store/ui';
import ModalSheet from './ModalSheet.vue';
import HubBrowser from './HubBrowser.vue';
const ui=useUiStore();
</script>
<template><ModalSheet title="查找" @close="ui.closeOverlay()"><HubBrowser mode="search" /></ModalSheet></template>
