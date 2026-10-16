<script setup lang="ts">
import { useI18n } from "vue-i18n";
import AppDialog from "@/components/AppDialog.vue";
import MIcon from "@/components/MIcon.vue";
import { describeError } from "@/utils/errors";

defineProps<{ errorCode: string | null }>();
const open = defineModel<boolean>({ required: true });
const { t } = useI18n();
</script>

<template>
  <AppDialog v-model="open" :title="t('home.rdpHelp.title')" width="540px">
    <template #icon><MIcon name="desktop_windows" :size="20" /></template>
    <div class="rdp-help">
      <p class="rdp-help__reason">{{ describeError(errorCode) }}</p>
      <p>{{ t("home.rdpHelp.linux") }}</p>
      <p>{{ t("home.rdpHelp.windows") }}</p>
      <p class="rdp-help__retry">{{ t("home.rdpHelp.retry") }}</p>
    </div>
    <template #footer>
      <button type="button" class="sl-btn-primary" @click="open = false">
        {{ t("workspace.close") }}
      </button>
    </template>
  </AppDialog>
</template>

<style scoped lang="scss">
.rdp-help {
  display: grid;
  gap: $spacing-16;
  line-height: $line-height-base;
}

.rdp-help__reason {
  color: var(--color-text-primary);
  font-weight: $font-weight-500;
}

.rdp-help__retry {
  color: var(--color-text-secondary);
}
</style>
