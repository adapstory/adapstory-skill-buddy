<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Installation } from '@skillbuddy/core'
import type { GitSourceInfo } from '#shared/ipc'
import { Button } from '@/components/ui/button'

const props = defineProps<{ installations: Installation[] }>()
const { t } = useI18n()
const sources = computed(() => props.installations.filter((item) => item.provenance?.kind === 'git'))
const selected = ref('')
const info = ref<GitSourceInfo | null>(null)
const error = ref('')
const busy = ref(false)
const message = ref('')
const pending = ref(false)
watch(sources, (items) => {
  if (!items.some((item) => item.path === selected.value)) selected.value = items[0]?.path ?? ''
}, { immediate: true })
watch(selected, (path) => {
  info.value = null; error.value = ''; message.value = ''; pending.value = false
  if (path) void refreshPending(path)
}, { immediate: true })

async function refreshPending(path: string): Promise<void> {
  try {
    const value = await window.skillsManager.pendingSkillPublication(path)
    if (selected.value === path) pending.value = value
  } catch (cause) {
    if (selected.value === path) error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function retry(): Promise<void> {
  const path = selected.value
  if (!path) return
  busy.value = true
  error.value = ''
  try {
    await window.skillsManager.retrySkillPublication(path)
    pending.value = false
    info.value = null
    message.value = t('detail.gitSourcePublished')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    await refreshPending(path)
  } finally {
    busy.value = false
  }
}

async function inspect(): Promise<void> {
  if (!selected.value) return
  busy.value = true
  error.value = ''
  try {
    info.value = await window.skillsManager.inspectSkillGit(selected.value, true)
  } catch (cause) {
    info.value = null
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function merge(action: 'merge' | 'finish'): Promise<void> {
  if (!selected.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const result = await window.skillsManager.mergeSkillGit(selected.value, action)
    info.value = await window.skillsManager.inspectSkillGit(selected.value, false)
    message.value = t(result.state === 'published' ? 'detail.gitSourcePublished' : result.state === 'unchanged' ? 'detail.gitSourceUnchanged' : 'detail.gitSourceConflicts')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
    await refreshPending(selected.value)
  } finally {
    busy.value = false
  }
}

async function openConflict(file: string): Promise<void> {
  try {
    await window.skillsManager.openSkillGitConflict(selected.value, file)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}
</script>

<template>
  <section v-if="sources.length" class="mb-8 space-y-2">
    <h3 class="text-sm font-medium">{{ t('detail.gitSourceTitle') }}</h3>
    <label class="flex flex-col gap-1 text-sm">
      {{ t('detail.gitSourceInstallation') }}
      <select v-model="selected" class="rounded-md border bg-background px-2 py-1 text-sm" :disabled="busy">
        <option v-for="source in sources" :key="source.installationId" :value="source.path">{{ source.agent }} · {{ source.path }}</option>
      </select>
    </label>
    <Button variant="outline" size="sm" :disabled="busy || !selected" @click="inspect">
      {{ t('detail.gitSourceRefresh') }}
    </Button>
    <div v-if="pending" class="space-y-2">
      <p class="text-sm">{{ t('detail.gitSourcePending') }}</p>
      <Button variant="outline" size="sm" :disabled="busy" @click="retry">{{ t('detail.gitSourceRetry') }}</Button>
    </div>
    <p v-if="error" role="alert" class="break-all text-sm text-destructive">{{ error }}</p>
    <p v-if="message" role="status" class="text-sm">{{ message }}</p>
    <div v-if="info" class="space-y-1 text-sm">
      <p class="break-all">{{ t('detail.gitSourceLocal') }}: {{ info.commit }}</p>
      <p class="break-all">{{ t('detail.gitSourceUpstream') }}: {{ info.upstreamCommit }}</p>
      <p v-if="info.upstreamOriginalCommit" class="break-all">{{ t('detail.gitSourceOriginalUpstream') }}: {{ info.upstreamOriginalCommit }}</p>
      <p v-if="info.dirty" class="text-amber-600">{{ t('detail.provenanceDirty') }}</p>
      <details v-if="info.diff">
        <summary class="cursor-pointer">{{ t('detail.gitSourceDiff') }}</summary>
        <pre class="mt-2 max-h-80 overflow-auto whitespace-pre text-xs">{{ info.diff }}</pre>
      </details>
      <p v-else>{{ t('detail.gitSourceNoDiff') }}</p>
      <div v-if="info.merging" class="space-y-2">
        <p>{{ t('detail.gitSourceConflicts') }}</p>
        <ul><li v-for="file in info.conflicts" :key="file"><Button variant="link" size="sm" :disabled="busy" @click="openConflict(file)">{{ file }}</Button></li></ul>
        <Button variant="outline" size="sm" :disabled="busy" @click="merge('finish')">{{ t('detail.gitSourceFinish') }}</Button>
      </div>
      <Button v-else variant="outline" size="sm" :disabled="busy || pending || info.dirty || !info.fetched" @click="merge('merge')">{{ t('detail.gitSourceMerge') }}</Button>
    </div>
  </section>
</template>
