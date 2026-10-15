<script lang="ts" setup>
import { useAppStore } from "@/store/app";
import { describeError } from "@/utils/errors";
import { theme } from "@/utils/appearance";
import { ElMessageBox } from "element-plus";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave } from "vue-router";
import BackendUrlUtils from "../../../electron/utils/BackendUrlUtils";
import pkg from "../../../package.json";
import MIcon from "@/components/MIcon.vue";
import PageHeader from "@/components/PageHeader.vue";
import SegmentedControl from "@/components/SegmentedControl.vue";
defineOptions({ name: "Config" });
const { t } = useI18n();
const appStore = useAppStore();
const updatePercent = computed(() => {
  const progress = appStore.updateProgress;
  return progress?.total
    ? Math.round((progress.received / progress.total) * 100)
    : 0;
});
const handleInstallUpdate = async () => {
  if (!appStore.updateInfo?.updateAvailable) return;
  try {
    await ElMessageBox.confirm(t("update.confirmMessage"), t("update.title"), {
      confirmButtonText: t("update.install"),
      cancelButtonText: t("update.later"),
      showClose: false,
      type: "warning"
    });
    appStore.installUpdate();
  } catch {
    // User cancelled.
  }
};

const themeOptions = computed(() => [
  { value: "light" as const, label: t("workspace.light"), icon: "light_mode" },
  { value: "dark" as const, label: t("workspace.dark"), icon: "dark_mode" },
  { value: "system" as const, label: t("workspace.system"), icon: "monitor" }
]);
const languageOptions = computed(() => [
  { value: "zh-TW", label: t("config.language.zhTW") },
  { value: "en-US", label: t("config.language.enUS") },
  { value: "ja", label: t("config.language.ja") }
]);
const autoStartOptions = computed(() => [
  { value: "on" as const, label: t("common.on") },
  { value: "off" as const, label: t("common.off") }
]);

const languageDraft = computed({
  get: () => appStore.language,
  set: (language: string) => {
    if (language !== appStore.language) appStore.saveSettings({ language });
  }
});
const autoStartDraft = computed<"on" | "off">({
  get: () => (appStore.autoStart ? "on" : "off"),
  set: value => {
    const launchAtStartup = value === "on";
    if (launchAtStartup !== appStore.autoStart)
      appStore.saveSettings({ launchAtStartup });
  }
});
const backendUrlDraft = ref(appStore.backendUrl);
const urlCheck = computed(() => BackendUrlUtils.parse(backendUrlDraft.value));
const urlDirty = computed(() => {
  const check = urlCheck.value;
  return (
    (check.ok ? check.url : backendUrlDraft.value.trim()) !==
    appStore.backendUrl
  );
});
const urlError = computed(() => {
  const check = urlCheck.value;
  return urlDirty.value && check.ok === false
    ? t(`config.backend.error.${check.problem}`)
    : "";
});
const urlChangeLogsOut = computed(
  () => appStore.loggedIn || appStore.tunnelStatus.running
);
watch(
  () => appStore.backendUrl,
  (next, previous) => {
    const check = urlCheck.value;
    if (
      backendUrlDraft.value.trim() === previous ||
      (check.ok && check.url === next)
    )
      backendUrlDraft.value = next;
  }
);
const confirmDanger = (title: string, message: string, confirmText: string) =>
  ElMessageBox.confirm(message, title, {
    confirmButtonText: confirmText,
    cancelButtonText: t("common.cancel"),
    confirmButtonClass: "sl-confirm-danger",
    showClose: false,
    type: "warning"
  })
    .then(() => true)
    .catch(() => false);

let applyingBackend: Promise<boolean> | null = null;
let submittedBackendUrl = "";
const applyBackend = (): Promise<boolean> => {
  if (applyingBackend) return applyingBackend;
  const check = urlCheck.value;
  if (!urlDirty.value || !check.ok) return Promise.resolve(true);
  if (appStore.settingsSaving && submittedBackendUrl === check.url)
    return Promise.resolve(true);
  applyingBackend = (async () => {
    if (
      urlChangeLogsOut.value &&
      !(await confirmDanger(
        t("config.backend.confirmTitle"),
        t("config.backend.confirmMessage"),
        t("config.backend.confirmButton")
      ))
    ) {
      backendUrlDraft.value = appStore.backendUrl;
      return true;
    }
    backendUrlDraft.value = check.url;
    submittedBackendUrl = check.url;
    appStore.saveSettings({ backendUrl: check.url });
    return true;
  })().finally(() => {
    applyingBackend = null;
  });
  return applyingBackend;
};
onBeforeRouteLeave(() => applyBackend());
const handleLogout = () => appStore.logout();
onMounted(() => {
  appStore.checkForUpdates();
  appStore.refreshSettings();
});
</script>
<template>
  <main class="workspace-page">
    <PageHeader :title="t('config.title')" />

    <!-- 寬視窗兩欄：左邊是要存檔的一般與伺服器（頁尾一顆儲存），右邊是軟體更新與帳號；窄視窗依序疊成一欄 -->
    <div class="settings-grid">
      <form class="settings-column" novalidate @submit.prevent="applyBackend">
        <section class="sl-card">
          <h2 class="sl-card__title">{{ t("config.general") }}</h2>
          <div class="sl-field">
            <span>{{ t("workspace.appearance") }}</span>
            <SegmentedControl
              v-model="theme"
              :options="themeOptions"
              :label="t('workspace.appearance')"
            />
          </div>
          <div class="sl-field">
            <span>{{ t("config.language.label") }}</span>
            <SegmentedControl
              v-model="languageDraft"
              :options="languageOptions"
              :label="t('config.language.label')"
            />
          </div>
          <div class="sl-field">
            <span>{{ t("config.autoStart.label") }}</span>
            <SegmentedControl
              v-model="autoStartDraft"
              :options="autoStartOptions"
              :label="t('config.autoStart.label')"
            />
            <small class="sl-field__hint">{{
              t("config.autoStart.tips")
            }}</small>
          </div>
        </section>

        <section class="sl-card">
          <h2 class="sl-card__title">{{ t("config.server") }}</h2>
          <label class="sl-field">
            <span>{{ t("config.backend.label") }}</span>
            <input
              v-model="backendUrlDraft"
              @blur="applyBackend"
              @keydown.enter.prevent="applyBackend"
              class="sl-input"
              :class="{ 'sl-input--invalid': !!urlError }"
              type="url"
              placeholder="https://skylab-tw.com"
              spellcheck="false"
              :aria-invalid="!!urlError"
              aria-describedby="backend-url-hint"
            />
            <small
              id="backend-url-hint"
              class="sl-field__hint"
              :class="{ 'sl-field__hint--error': !!urlError }"
              :role="urlError ? 'alert' : undefined"
              >{{ urlError || t("config.backend.tips") }}</small
            >
          </label>
          <p
            v-if="urlDirty && !urlError && urlChangeLogsOut"
            class="sl-notice sl-notice--pending"
          >
            <MIcon name="warning_amber" :size="18" />{{
              t("config.backend.logoutNotice")
            }}
          </p>
        </section>

        <p v-if="appStore.settingsSaving" class="sl-field__hint" role="status">
          {{ t("config.applying") }}
        </p>
        <p
          v-if="appStore.settingsErrorCode"
          class="sl-notice sl-notice--danger"
          role="alert"
        >
          {{
            t("config.saveFailed", {
              error: describeError(appStore.settingsErrorCode)
            })
          }}
        </p>
      </form>

      <div class="settings-column">
        <section class="sl-card" aria-live="polite">
          <div class="sl-card__header">
            <div>
              <h2 class="sl-card__title">
                {{ t("update.settingsTitle") }}
                <i
                  v-if="appStore.updateInfo?.updateAvailable"
                  class="update-dot"
                  :aria-label="t('update.available')"
                />
              </h2>
              <p class="sl-card__hint">
                {{ t("update.currentVersion") }} v{{ pkg.version }}
              </p>
            </div>
            <button
              type="button"
              class="sl-btn-secondary"
              :disabled="appStore.updateChecking || appStore.updateInstalling"
              @click="appStore.checkForUpdates(true)"
            >
              <MIcon name="sync" :size="16" :spin="appStore.updateChecking" />{{
                t("update.check")
              }}
            </button>
          </div>
          <p
            v-if="appStore.updateCheckError"
            class="sl-notice sl-notice--danger"
          >
            <MIcon name="error_outline" :size="18" />{{
              t("update.checkError")
            }}
          </p>
          <template v-else-if="appStore.updateInfo">
            <div v-if="appStore.updateInfo.updateAvailable" class="update-row">
              <span class="sl-badge sl-badge--info">
                <MIcon name="new_releases" :size="14" />{{
                  t("update.availableVersion", {
                    version: appStore.updateInfo.latestVersion
                  })
                }}
              </span>
              <button
                type="button"
                class="sl-btn-primary"
                :disabled="appStore.updateInstalling"
                @click="handleInstallUpdate"
              >
                <MIcon name="download" :size="16" />{{ t("update.install") }}
              </button>
            </div>
            <span v-else class="sl-badge sl-badge--success update-latest">
              <MIcon name="check_circle" :size="14" />{{ t("update.upToDate") }}
            </span>
          </template>
          <template v-if="appStore.updateInstalling && appStore.updateProgress">
            <p class="update-progress">
              {{ t(`update.${appStore.updateProgress.stage}`)
              }}<span v-if="appStore.updateProgress.stage === 'downloading'">
                {{ updatePercent }}%</span
              >
            </p>
            <el-progress
              v-if="appStore.updateProgress.stage === 'downloading'"
              :percentage="updatePercent"
              :stroke-width="8"
              :show-text="false"
            />
          </template>
          <p
            v-if="appStore.updateInstallErrorCode"
            class="sl-notice sl-notice--danger"
          >
            <MIcon name="error_outline" :size="18" />{{
              describeError(appStore.updateInstallErrorCode)
            }}
          </p>
        </section>

        <section class="sl-card">
          <h2 class="sl-card__title">{{ t("config.account.label") }}</h2>
          <div class="account-row">
            <span
              class="sl-badge"
              :class="
                appStore.loggedIn ? 'sl-badge--success' : 'sl-badge--muted'
              "
            >
              <MIcon
                :name="appStore.loggedIn ? 'verified_user' : 'person_off'"
                :size="14"
              />{{
                t(
                  appStore.loggedIn
                    ? "config.account.loggedIn"
                    : "config.account.notLoggedIn"
                )
              }}
            </span>
            <button
              v-if="appStore.loggedIn"
              type="button"
              class="sl-btn-danger-outline"
              @click="handleLogout"
            >
              <MIcon name="logout" :size="16" />{{ t("config.account.logout") }}
            </button>
          </div>
          <p v-if="!appStore.loggedIn" class="sl-card__hint">
            {{ t("config.account.loginHint") }}
          </p>
        </section>
      </div>
    </div>
  </main>
</template>

<style lang="scss" scoped>
.settings-grid,
.settings-column {
  @include flex-column;
  gap: $spacing-24;
}

/* 內容區夠寬才分兩欄（.desktop-main 是 container）；兩欄各自往下長，不用等高 */
@container (min-width: 880px) {
  .settings-grid {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    align-items: start;
  }
}

.sl-card__title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.update-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-danger);
}

/* 徽章裡帶圖示：圖示與文字間距 */
.sl-badge {
  gap: 4px;
}

.update-latest {
  align-self: flex-start;
}

.update-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: $spacing-8;
}

.update-progress {
  color: var(--color-text-muted);
  font-size: $font-size-14;
}

.account-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

/* 頁尾儲存列：同 web 設定頁的 .saveBar（一般頁尾、靠右，不黏在畫面底） */
</style>
