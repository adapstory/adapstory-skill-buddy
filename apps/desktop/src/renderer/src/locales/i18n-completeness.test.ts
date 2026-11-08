import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from './en'
import zhCN from './zh-CN'
import ruCore from './ru-core'
import ruRest from './ru-rest'
import { MCP_SO_CATEGORY_KEYS, MODELSCOPE_CATEGORY_KEYS } from '@/lib/mcp-market'
import { PLATFORM_DRAFT_ERROR_KEYS } from '@/lib/platform-draft'

function flattenKeys(value: unknown, prefix = '', result = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    result.add(path)
    flattenKeys(child, path, result)
  }
  return result
}

function messages(value: unknown, prefix = '', result = new Map<string, string>()): Map<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') result.set(path, child)
    else messages(child, path, result)
  }
  return result
}

function sourceFiles(directory: string, result: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) sourceFiles(path, result)
    else if (/\.(?:ts|vue)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) result.push(path)
  }
  return result
}

function staticTranslationKeys(): Set<string> {
  const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const result = new Set<string>()
  const callPattern = /(?:\$t|i18n\.global\.t|(?<![\w.])t)\(\s*(['"])([^'"\n]+)\1/g
  const keypathPattern = /(?<!:)\bkeypath\s*=\s*['"]([^'"]+)['"]/g
  for (const path of sourceFiles(rendererRoot)) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(callPattern)) result.add(match[2]!)
    for (const match of source.matchAll(keypathPattern)) result.add(match[1]!)
  }
  return result
}

function dynamicTranslationKeys(): string[] {
  const keys = [
    ...['fallback', 'shadowed', 'requires-config', 'unsupported'].map((value) => `instructions.role.${value}`),
    ...['official', 'verified', 'community', 'unknown'].map((value) => `instructions.evidence.${value}`),
    ...['write', 'delete', 'bridge'].flatMap((intent) => [
      `instructions.plan.${intent}Title`,
      `instructions.plan.${intent}Action`,
    ]),
    ...['empty', 'enabled', 'disabled', 'partial', 'unavailable'].map((value) => `groups.status.${value}`),
    ...['enable', 'disable'].flatMap((action) => [
      `groups.${action}Title`,
      `groups.${action}Action`,
      `groups.${action}Done`,
    ]),
    ...['upsert', 'remove', 'enable', 'disable'].flatMap((intent) => [
      `mcp.plan.intent.${intent}`,
      `mcp.plan.action.${intent}`,
      `mcp.plan.confirm.${intent}`,
    ]),
    ...['ready', 'missing-secrets', 'requires-oauth', 'unknown'].map((value) => `mcp.auth.${value}`),
    ...['satisfied', 'missing', 'outdated', 'unresolved', 'blocked'].flatMap((state) => [
      `team.projectState.${state}`,
      `team.projectInstructionState.${state}`,
    ]),
    ...['unresolved-ref', 'bundle-missing-members', 'bundle-incomplete', 'blocked-policy'].map((reason) => `team.projectReason.${reason}`),
    ...['enable', 'disable', 'uninstall'].flatMap((action) => [
      `batch.${action}Title`,
      `batch.${action}Confirm`,
      `batch.${action}Action`,
    ]),
    ...['enable', 'disable'].map((action) => `batch.${action}Done`),
    ...['enable', 'disable'].flatMap((action) =>
      ['Agent', 'ScopeAgent', 'Scope', 'Global'].flatMap((context) =>
        ['Title', 'Confirm', 'Action'].map((suffix) => `card.${action}${context}${suffix}`),
      ),
    ),
    ...MODELSCOPE_CATEGORY_KEYS.map((value) => `mcp.market.categories.${value}`),
    ...MCP_SO_CATEGORY_KEYS.map((value) => `mcp.market.categories.${value}`),
    ...Object.values(PLATFORM_DRAFT_ERROR_KEYS),
  ]
  return [...new Set(keys)]
}

describe('renderer locale completeness', () => {
  const zhKeys = flattenKeys(zhCN)
  const enKeys = flattenKeys(en)
  const ruKeys = flattenKeys({ ...ruCore, ...ruRest })

  it('provides Russian messages for every English key', () => {
    expect([...enKeys].filter((key) => !ruKeys.has(key))).toEqual([])
    expect([...ruKeys].filter((key) => !enKeys.has(key))).toEqual([])
  })

  it('renders Russian messages with the same named parameters', () => {
    const english = messages(en)
    const russian = messages({ ...ruCore, ...ruRest })
    const translator = createI18n({ legacy: false, locale: 'ru', messages: { ru: { ...ruCore, ...ruRest } } })
    for (const [key, original] of english) {
      const translated = russian.get(key)
      expect(translated, key).toBeDefined()
      if (translated === undefined) continue
      const parameters = (text: string) => [...text.matchAll(/\{([A-Za-z_]\w*)\}/g)].map((match) => match[1]).sort()
      const names = parameters(original)
      expect(parameters(translated), key).toEqual(names)
      const values = Object.fromEntries(names.map((name) => [name, 'test']))
      expect(() => translator.global.t(key, values)).not.toThrow()
    }
  })

  it('keeps Chinese and English locale key trees aligned', () => {
    expect([...zhKeys].filter((key) => !enKeys.has(key))).toEqual([])
    expect([...enKeys].filter((key) => !zhKeys.has(key))).toEqual([])
  })

  it('defines every statically referenced translation key', () => {
    const used = staticTranslationKeys()
    expect([...used].filter((key) => !zhKeys.has(key))).toEqual([])
    expect([...used].filter((key) => !enKeys.has(key))).toEqual([])
  })

  it('defines translation keys generated from runtime enums', () => {
    const used = dynamicTranslationKeys()
    expect(used.filter((key) => !zhKeys.has(key))).toEqual([])
    expect(used.filter((key) => !enKeys.has(key))).toEqual([])
  })
})
