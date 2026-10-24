<script setup lang="ts">
// 全局覆盖层宿主：按 ui.overlay 渲染对应覆盖层；确认框独立叠放（可在 create/review 等之上）。
import { useUiStore } from '@/store/ui';
import ModalSheet from './ModalSheet.vue';
import AnnouncementFormOverlay from './AnnouncementFormOverlay.vue';
import AnnouncementOverlay from './AnnouncementOverlay.vue';
import CopyFallbackOverlay from './CopyFallbackOverlay.vue';
import NotificationSettingsOverlay from './NotificationSettingsOverlay.vue';
import AboutOverlay from './AboutOverlay.vue';
import SearchOverlay from './SearchOverlay.vue';

const ui = useUiStore();
</script>

<template>
  <div v-if="ui.overlay" id="overlays">
    <AnnouncementFormOverlay v-if="ui.overlay === 'announcementForm'" />
    <AnnouncementOverlay :key="String(ui.overlayProps.announcementId)" v-else-if="ui.overlay === 'announcement'" />
    <CopyFallbackOverlay v-else-if="ui.overlay === 'copyFallback'" />
    <NotificationSettingsOverlay v-else-if="ui.overlay === 'notificationSettings'" />
    <AboutOverlay v-else-if="ui.overlay === 'about'" />
    <SearchOverlay v-else-if="ui.overlay === 'search'" />
  </div>

  <!-- 确认框：独立层，叠在内容覆盖层之上 -->
  <div v-if="ui.confirmVisible && ui.confirmOptions" id="confirm-layer">
    <ModalSheet class="confirm-overlay" style="z-index:120" :title="ui.confirmOptions.title" @close="ui.resolveConfirm(false)">
        <p class="body-text">{{ ui.confirmOptions.text }}</p>
        <template #footer>
          <button class="btn" @click="ui.resolveConfirm(false)">{{ ui.confirmOptions.cancelLabel || '返回' }}</button>
          <button class="btn" :class="ui.confirmOptions.danger ? 'danger' : 'primary'" @click="ui.resolveConfirm(true)">{{ ui.confirmOptions.label || '确认' }}</button>
        </template>
    </ModalSheet>
  </div>
</template>
