<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { FolderOpen, Link2, LockKeyhole, Trash2, TriangleAlert, Unlink } from '@lucide/vue'
import type { Installation } from '@skillbuddy/core'
import CopyButton from '@/components/CopyButton.vue'
import PlatformIcon from '@/components/PlatformIcon.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { agentLabel } from '@/lib/agents'

/** 安装位置列表只展示安装状态，并将文件操作意图交给详情页统一执行。 */
const props = defineProps<{
  installations: Installation[]
  busy: boolean
}>()

const emit = defineEmits<{
  reveal: [path: string]
  remove: [path: string]
  toggle: [installation: Installation]
}>()

const { t } = useI18n()

function installationEnabled(installation: Installation): boolean {
  return installation.enabled !== false
}

/**
 * 是否给出移除入口。断链条目无法启停（`canToggle` 为 false），但上游本体消失后
 * 这条引用必须还能摘掉，否则它会永远留在列表里。
 */
function canRemove(installation: Installation): boolean {
  if (installation.readOnly) return false
  return installation.canToggle !== false || installation.linkBroken === true
}

/** 链接型 Skill 的角标提示：说明启停只搬动引用，上游本体不受影响。 */
function linkTitle(installation: Installation): string {
  const target = installation.linkTarget ?? ''
  if (installation.linkBroken) {
    return target ? t('detail.linkBrokenHint', { target }) : t('detail.linkBroken')
  }
  return target ? t('detail.linkedHint', { target }) : t('detail.linked')
}

/** 解析失败角标的悬浮说明：给出文件路径、行号与解析器原文。 */
function parseErrorTitle(installation: Installation): string {
  const error = installation.parseError
  if (!error) return ''
  const line = error.line ? ` ${t('detail.parseErrorAt', { line: error.line })}` : ''
  return `${t('detail.parseErrorHint')}\n${error.path}${line}\n${error.message}`
}

function pathBaseName(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return normalized.split('/').pop() ?? normalized
}

function originLabel(installation: Installation): string {
  let label: string
  switch (installation.origin) {
    case 'shared':
      label = t('detail.originShared')
      break
    case 'legacy':
      label = t('detail.originLegacy')
      break
    case 'admin':
      label = t('detail.originAdmin')
      break
    case 'system':
      label = t('detail.originSystem')
      break
    case 'plugin':
      label = t('detail.originPlugin')
      break
    case 'project':
      label = t('detail.scopeProject')
      break
    default:
      label = t('detail.scopeUser')
  }
  const projectName = installation.projectRoot ? pathBaseName(installation.projectRoot) : ''
  return installation.scope === 'project' && projectName
    ? `${label} · ${projectName}`
    : label
}

function provenanceLabel(installation: Installation): string {
  const provenance = installation.provenance
  if (provenance?.kind === 'git') {
    return `${provenance.upstream} · ${provenance.commit.slice(0, 8)}${provenance.dirty ? ` · ${t('detail.provenanceDirty')}` : ''}`
  }
  if (provenance?.kind === 'manual') return t('detail.provenanceManual')
  if (provenance?.kind === 'codex') {
    return provenance.git
      ? `${t('detail.provenanceCodex')} · ${t('detail.provenanceLocalCommit')} ${provenance.git.commit.slice(0, 8)}${provenance.git.dirty ? ` · ${t('detail.provenanceDirty')}` : ''}`
      : t('detail.provenanceCodex')
  }
  if (provenance?.kind === 'archive') return [t('detail.provenanceArchive'), provenance.url, provenance.archiveType].filter(Boolean).join(' · ')
  return t(provenance?.kind === 'plugin' ? 'detail.provenancePlugin' : 'detail.provenanceUnknown')
}

function provenanceTitle(installation: Installation): string | undefined {
  const provenance = installation.provenance
  if (provenance?.kind === 'git') return `${provenance.upstream}\n${provenance.origin}\n${provenance.commit}`
  if (provenance?.kind === 'codex' && provenance.git) return `${t('detail.provenanceLocalCommit')}\n${provenance.git.commit}\n${provenance.git.repository}`
  return undefined
}
</script>

<template>
  <section class="mb-8">
    <h3 class="mb-2 text-sm font-medium">
      {{ t('detail.installedLocations') }}
    </h3>
    <ul class="flex flex-col gap-2">
      <li
        v-for="installation in props.installations"
        :key="installation.path"
        class="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
      >
        <div class="flex min-w-0 items-center gap-2">
          <PlatformIcon :id="installation.agent" :size="15" />
          <span class="shrink-0 text-sm">{{ agentLabel(installation.agent) }}</span>
          <Badge
            variant="secondary"
            class="max-w-48 shrink-0 rounded-md px-2 py-0.5 font-normal"
            :title="installation.scope === 'project' ? installation.projectRoot : undefined"
          >
            <span class="truncate">{{ originLabel(installation) }}</span>
          </Badge>
          <Badge variant="outline" class="max-w-64 truncate" :title="provenanceTitle(installation)">
            {{ provenanceLabel(installation) }}
          </Badge>
          <Badge
            variant="outline"
            :class="[
              'shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 font-normal',
              !installationEnabled(installation) &&
                'border-amber-500/40 text-amber-600 dark:text-amber-400',
            ]"
          >
            {{ installationEnabled(installation) ? t('detail.enabled') : t('detail.disabled') }}
          </Badge>
          <Tooltip
            v-if="installation.linked"
            :content="linkTitle(installation)"
            content-class="max-w-96 whitespace-pre-line break-all"
          >
            <Badge
              variant="outline"
              :class="[
                'flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 font-normal',
                installation.linkBroken
                  ? 'border-destructive/40 text-destructive'
                  : 'text-muted-foreground',
              ]"
            >
              <Unlink v-if="installation.linkBroken" class="size-3 shrink-0" />
              <Link2 v-else class="size-3 shrink-0" />
              <span class="truncate">
                {{ installation.linkBroken ? t('detail.linkBroken') : t('detail.linked') }}
              </span>
            </Badge>
          </Tooltip>
          <Tooltip
            v-if="installation.parseError"
            :content="parseErrorTitle(installation)"
            content-class="max-w-96 whitespace-pre-line break-all"
          >
            <Badge
              variant="outline"
              class="flex items-center gap-1 whitespace-nowrap rounded-md border-destructive/40 px-2 py-0.5 font-normal text-destructive"
            >
              <TriangleAlert class="size-3 shrink-0" />
              <span class="truncate">{{ t('detail.parseError') }}</span>
            </Badge>
          </Tooltip>
        </div>
        <span class="flex shrink-0 items-center gap-0.5">
          <CopyButton :text="installation.path" class="size-7" />
          <Button
            variant="ghost"
            size="icon"
            class="size-7 cursor-pointer text-muted-foreground"
            :title="t('detail.revealInFinder')"
            @click="emit('reveal', installation.path)"
          >
            <FolderOpen class="size-3.5" />
          </Button>
          <Button
            v-if="canRemove(installation)"
            variant="ghost"
            size="icon"
            class="size-7 cursor-pointer text-muted-foreground hover:text-destructive"
            :disabled="props.busy"
            :title="t('detail.removeOne')"
            @click="emit('remove', installation.path)"
          >
            <Trash2 class="size-3.5" />
          </Button>
          <LockKeyhole
            v-else
            class="mx-1.5 size-3.5 text-muted-foreground"
            :title="t('detail.readOnly')"
          />
          <button
            v-if="!installation.readOnly && installation.canToggle !== false"
            type="button"
            role="switch"
            :aria-checked="installationEnabled(installation)"
            :aria-label="t(installationEnabled(installation) ? 'detail.disable' : 'detail.enable')"
            :title="t(installationEnabled(installation) ? 'detail.disable' : 'detail.enable')"
            :disabled="props.busy"
            class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-all disabled:cursor-not-allowed disabled:opacity-50"
            :class="
              installationEnabled(installation)
                ? 'bg-emerald-500 shadow-sm ring-2 ring-emerald-500/20'
                : 'bg-muted-foreground/25'
            "
            @click="emit('toggle', installation)"
          >
            <span
              class="size-3.5 rounded-full bg-white shadow-sm transition-transform"
              :class="
                installationEnabled(installation) ? 'translate-x-[18px]' : 'translate-x-[3px]'
              "
            />
          </button>
        </span>
      </li>
    </ul>
  </section>
</template>
