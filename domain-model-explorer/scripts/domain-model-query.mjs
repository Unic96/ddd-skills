#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'

const CONFIG_DIR = `${os.homedir()}/.config/domain-model-explorer`
const CONFIG_PATH = `${CONFIG_DIR}/auth.json`
const DEFAULT_BASE_URL = 'https://ddd.hixqz.com/api/v1'
const DEFAULT_AUTH_PERMISSION = 'write'
const DEFAULT_AUTH_EXPIRES_IN_SECONDS = 86400
const SUMMARY_STYLE = process.env.DOMAIN_MODEL_SUMMARY_STYLE || 'explain'

class QueryError extends Error {}

function decodeJwtPayload(token) {
  if (!token || token.split('.').length !== 3) {
    return null
  }
  try {
    const payload = token.split('.')[1]
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
  } catch {
    return null
  }
}

function getTokenInfo(token = ACCESS_TOKEN) {
  const claims = decodeJwtPayload(token)
  if (!claims || typeof claims !== 'object') {
    return null
  }

  const permissions = Array.isArray(claims.permissions)
    ? claims.permissions.filter((item) => typeof item === 'string')
    : []

  return {
    projectId: typeof claims.projectId === 'string' ? claims.projectId : undefined,
    permissions,
    exp: typeof claims.exp === 'number' ? claims.exp : undefined,
    isExpired: typeof claims.exp === 'number' ? claims.exp <= Math.floor(Date.now() / 1000) : false,
  }
}

function hasRequiredPermission(tokenInfo, requiredPermission = 'read') {
  if (!tokenInfo) {
    return false
  }
  if (tokenInfo.permissions.includes('write')) {
    return true
  }
  return tokenInfo.permissions.includes(requiredPermission)
}

function canReuseCurrentToken({ requestedProjectId, requiredPermission = 'read' } = {}) {
  if (!hasUserToken()) {
    return { reusable: false, reason: 'missing' }
  }

  const tokenInfo = getTokenInfo()
  if (!tokenInfo) {
    return { reusable: false, reason: 'invalid' }
  }
  if (tokenInfo.isExpired) {
    return { reusable: false, reason: 'expired', tokenInfo }
  }

  const effectiveProjectId = requestedProjectId || PROJECT_ID
  const tokenProjectId = tokenInfo.projectId || PROJECT_ID
  if (effectiveProjectId && tokenProjectId && effectiveProjectId !== tokenProjectId) {
    return { reusable: false, reason: 'project-mismatch', tokenInfo }
  }
  if (!hasRequiredPermission(tokenInfo, requiredPermission)) {
    return { reusable: false, reason: 'permission-mismatch', tokenInfo }
  }

  return { reusable: true, reason: 'ok', tokenInfo }
}

function formatTokenExpiry(tokenInfo) {
  if (!tokenInfo?.exp) {
    return '未知'
  }
  return new Date(tokenInfo.exp * 1000).toISOString()
}

function formatPermissionSummary(tokenInfo) {
  if (!tokenInfo?.permissions?.length) {
    return '未知'
  }
  return tokenInfo.permissions.join(',')
}

function looksLikeUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function loadLocalConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

const LOCAL_CONFIG = loadLocalConfig()

function resolveBaseUrl() {
  const resolved = process.env.DOMAIN_MODEL_API_BASE_URL || LOCAL_CONFIG.baseUrl || DEFAULT_BASE_URL
  return resolved.replace(/\/$/, '')
}

const BASE_URL = resolveBaseUrl()
const ACCESS_TOKEN = process.env.DOMAIN_MODEL_ACCESS_TOKEN || LOCAL_CONFIG.accessToken || ''
const PROJECT_ID = process.env.DOMAIN_MODEL_PROJECT_ID || LOCAL_CONFIG.projectId || ''

function hasUserToken() {
  return Boolean(ACCESS_TOKEN)
}

function requireAuthConfig() {
  if (!hasUserToken()) {
    throw new QueryError(
      '缺少查询凭证。请先执行 auth-init 和 auth-login，或提供 DOMAIN_MODEL_ACCESS_TOKEN。'
    )
  }

  if (!PROJECT_ID) {
    throw new QueryError('缺少 DOMAIN_MODEL_PROJECT_ID。用户态查询令牌需要项目范围，请先执行 auth-init。')
  }
}

function authModeLabel() {
  if (hasUserToken()) {
    return 'user-token'
  }
  return 'missing'
}

function resolveOrigin(baseUrl) {
  if (baseUrl.includes('/api/v1')) {
    return baseUrl.split('/api/v1', 1)[0]
  }
  if (baseUrl.includes('/api/')) {
    return baseUrl.split('/api/', 1)[0]
  }
  return baseUrl
}

function authLoginUrl(
  baseUrl,
  projectId,
  permission = DEFAULT_AUTH_PERMISSION,
  expiresIn = DEFAULT_AUTH_EXPIRES_IN_SECONDS,
) {
  const params = new URLSearchParams({
    projectId,
    permission,
    expiresIn: String(expiresIn),
  })
  return `${resolveOrigin(baseUrl)}/api/auth/access-token?${params.toString()}`
}

function authBrowserStartUrl(
  baseUrl,
  sessionId,
  projectId,
  permission = DEFAULT_AUTH_PERMISSION,
  expiresIn = DEFAULT_AUTH_EXPIRES_IN_SECONDS,
) {
  const params = new URLSearchParams({
    sessionId,
    permission,
    expiresIn: String(expiresIn),
  })
  if (projectId) {
    params.set('projectId', projectId)
  }
  return `${resolveOrigin(baseUrl)}/api/auth/query-access/start?${params.toString()}`
}

function authBrowserCompleteUrl(baseUrl, sessionId) {
  return `${resolveOrigin(baseUrl)}/api/auth/query-access/complete?${new URLSearchParams({ sessionId }).toString()}`
}

function writeLocalConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
}

function buildLocalConfigUpdates({ projectId, accessToken, baseUrl } = {}) {
  const config = { ...LOCAL_CONFIG }
  delete config.apiKey
  if (projectId !== undefined && projectId !== null) {
    config.projectId = projectId
  }
  if (accessToken !== undefined && accessToken !== null) {
    config.accessToken = accessToken
  }
  if (baseUrl !== undefined && baseUrl !== null) {
    config.baseUrl = baseUrl.replace(/\/$/, '')
  }
  return config
}

function formatApiErrorMessage(error) {
  const message = error?.message || '请求失败'
  const hint = error?.details?.hint
  return hint ? `${message} 建议：${hint}` : message
}

function maybeParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function fetchJsonAbsolute(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  })
  const text = await response.text()
  const payload = maybeParseJson(text)
  if (!response.ok) {
    if (payload?.error && typeof payload.error === 'object') {
      throw new QueryError(formatApiErrorMessage(payload.error))
    }
    throw new QueryError(text || `HTTP ${response.status}`)
  }
  if (!payload) {
    throw new QueryError('无法解析服务端返回结果')
  }
  return payload
}

async function apiRequest(method, path, { params = null, body } = {}) {
  const url = new URL(`${BASE_URL}${path}`)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    })
  }

  const headers = { Accept: 'application/json' }
  headers.Authorization = `Bearer ${ACCESS_TOKEN}`
  headers['X-Project-Id'] = PROJECT_ID
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    throw new QueryError(`请求失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  const text = await response.text()
  const payload = maybeParseJson(text)
  if (!response.ok) {
    if (payload?.error && typeof payload.error === 'object') {
      throw new QueryError(formatApiErrorMessage(payload.error))
    }
    throw new QueryError(text || `HTTP ${response.status}`)
  }
  if (!payload) {
    throw new QueryError('无法解析服务端返回结果')
  }
  if (payload.error) {
    if (typeof payload.error === 'object') {
      throw new QueryError(formatApiErrorMessage(payload.error))
    }
    throw new QueryError(String(payload.error))
  }
  return payload.data
}

async function apiGet(path, params = null) {
  return apiRequest('GET', path, { params })
}

async function apiPost(path, body) {
  return apiRequest('POST', path, { body })
}

async function apiPut(path, body) {
  return apiRequest('PUT', path, { body })
}

async function apiDelete(path) {
  return apiRequest('DELETE', path)
}

function jsonDump(data) {
  console.log(JSON.stringify(data, null, 2))
}

async function getContexts() {
  const data = await apiGet('/contexts')
  if (!Array.isArray(data)) {
    throw new QueryError('无法解析上下文列表结果')
  }
  return data
}

async function findContext(contextName) {
  const contexts = await getContexts()
  for (const item of contexts) {
    if (item?.name === contextName) {
      return item
    }
  }
  const available = contexts.slice(0, 8).map((context) => context?.name || '').join('、')
  throw new QueryError(`错误: 上下文不存在。可先查看这些上下文：${available}`)
}

async function getContextNodes(contextName, nameFilter = '', includeProperties = false, includeRules = false) {
  const context = await findContext(contextName)
  const data = await apiGet(`/contexts/${context.id}/nodes`, {
    name: nameFilter,
    includeProperties: String(includeProperties),
    includeRules: String(includeRules),
  })
  if (!Array.isArray(data)) {
    throw new QueryError('无法解析上下文节点结果')
  }
  return data
}

async function resolveNode(nodeName) {
  if (looksLikeUuid(nodeName)) {
    try {
      const detail = await apiGet(`/nodes/${nodeName}`)
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        const contexts = await getContexts()
        const context = contexts.find((item) => item?.id === detail.boundedContextId) || null
        return { detail, context }
      }
    } catch (error) {
      if (!(error instanceof QueryError) || !error.message.includes('节点不存在')) {
        throw error
      }
    }
  }

  const matches = []
  for (const context of await getContexts()) {
    const nodes = await apiGet(`/contexts/${context.id}/nodes`, {
      name: nodeName,
      includeProperties: 'false',
      includeRules: 'false',
    })
    if (!Array.isArray(nodes)) {
      continue
    }
    for (const node of nodes) {
      if (node?.name === nodeName) {
        matches.push({ node, context })
      }
    }
  }

  if (!matches.length) {
    throw new QueryError('错误: 节点不存在')
  }

  if (matches.length > 1) {
    const contexts = matches.slice(0, 6).map((item) => item.context.name).join('、')
    throw new QueryError(`错误: 找到多个同名节点，分布在这些上下文：${contexts}`)
  }

  const { node, context } = matches[0]
  const detail = await apiGet(`/nodes/${node.id}`)
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new QueryError('无法解析节点详情结果')
  }
  return { detail, context }
}

async function getNodeRelations(nodeName, direction = 'outgoing', scope = 'context', nodeTypesCsv = 'Event') {
  const resolved = await resolveNode(nodeName)
  const data = await apiGet(`/nodes/${resolved.detail.id}/relations`, {
    direction,
    scope,
    nodeTypes: nodeTypesCsv,
  })
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new QueryError('无法解析关系查询结果')
  }
  return data
}

function ensureObjectPayload(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QueryError(`${label} 必须是 JSON 对象`)
  }
  return value
}

function parseJsonArg(raw, label) {
  try {
    return ensureObjectPayload(JSON.parse(raw), label)
  } catch (error) {
    if (error instanceof QueryError) {
      throw error
    }
    throw new QueryError(`${label} 必须是合法 JSON`)
  }
}

function pickFirstString(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function omitKeys(payload, keys) {
  const next = { ...payload }
  for (const key of keys) {
    delete next[key]
  }
  return next
}

function toPascalCase(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function inferValueObjectTypeName(propertyName, rawType) {
  const normalizedType = typeof rawType === 'string' ? rawType.trim() : ''
  const genericMatch = normalizedType.match(/^enum\s*<\s*([A-Za-z][A-Za-z0-9_]*)\s*>$/i)
  if (genericMatch) {
    return genericMatch[1]
  }

  const nameFromProperty = toPascalCase(propertyName)
  if (nameFromProperty) {
    return nameFromProperty
  }
  return 'EnumValue'
}

function isGenericValueObjectTypeName(typeName) {
  const normalized = String(typeName || '').trim().toLowerCase()
  return new Set([
    'status',
    'state',
    'type',
    'kind',
    'mode',
    'category',
    'level',
    'phase',
    'reason',
    'result',
    'flag',
    'code',
    'value',
    'option',
  ]).has(normalized)
}

function extractEnumCandidatesFromType(rawType) {
  if (typeof rawType !== 'string') {
    return []
  }
  const match = rawType.trim().match(/^enum\s*\((.*)\)$/i)
  if (!match) {
    return []
  }
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function isEnumLikeProperty(property) {
  if (!property || typeof property !== 'object' || Array.isArray(property)) {
    return false
  }
  if (typeof property.type === 'string' && /^enum(\s*<.*?>|\s*\(.*\)|\b)/i.test(property.type.trim())) {
    return true
  }
  if (Array.isArray(property.enumValues) && property.enumValues.length > 0) {
    return true
  }
  if (Array.isArray(property.enums) && property.enums.length > 0) {
    return true
  }
  return false
}

function appendNormalizationRule(existingRules, note) {
  if (!note) {
    return existingRules
  }
  if (!Array.isArray(existingRules)) {
    return [note]
  }
  if (existingRules.every((item) => typeof item === 'string')) {
    return existingRules.includes(note) ? existingRules : [...existingRules, note]
  }
  return existingRules
}

function normalizeEnumLikeProperties(properties, rules) {
  if (!Array.isArray(properties)) {
    return { properties: [], rules: Array.isArray(rules) ? rules : [], notes: [] }
  }

  let nextRules = Array.isArray(rules) ? [...rules] : []
  const notes = []

  const nextProperties = properties.map((property) => {
    if (!property || typeof property !== 'object' || Array.isArray(property)) {
      return property
    }
    if (!isEnumLikeProperty(property)) {
      return property
    }

    const explicitValueObjectType = pickFirstString(property, ['valueObjectType', 'valueObject', 'voType'])
    const valueObjectType = inferValueObjectTypeName(property.name, property.type)
    const resolvedValueObjectType = explicitValueObjectType || valueObjectType
    const inlineCandidates = extractEnumCandidatesFromType(property.type)
    const explicitCandidates = Array.isArray(property.enumValues)
      ? property.enumValues
      : Array.isArray(property.enums)
        ? property.enums
        : []
    const candidates = [...new Set([...inlineCandidates, ...explicitCandidates].map((item) => String(item).trim()).filter(Boolean))]

    if (!explicitValueObjectType && isGenericValueObjectTypeName(resolvedValueObjectType)) {
      const propertyLabel = property.name || '<unknown>'
      throw new QueryError(
        `属性 ${propertyLabel} 是枚举语义，但当前只能推断出过于泛化的值对象名 ${resolvedValueObjectType}。请显式提供更具体的 valueObjectType，例如 OrderStatus、PaymentStatus、DiskType。`
      )
    }

    const nextProperty = { ...property, type: resolvedValueObjectType }
    delete nextProperty.enumValues
    delete nextProperty.enums
    delete nextProperty.enum
    delete nextProperty.valueObjectType
    delete nextProperty.valueObject
    delete nextProperty.voType

    let note = `${property.name || resolvedValueObjectType} 为值对象类型 ${resolvedValueObjectType}，不展开内部属性`
    if (candidates.length > 0) {
      note += `；可选值：${candidates.join('、')}`
    }
    note += '。'

    nextRules = appendNormalizationRule(nextRules, note)
    notes.push(`已将属性 ${property.name || '<unknown>'} 的枚举类型标准化为值对象 ${resolvedValueObjectType}`)
    return nextProperty
  })

  return { properties: nextProperties, rules: nextRules, notes }
}

async function resolveContextRef(contextRef) {
  const contexts = await getContexts()
  for (const context of contexts) {
    if (context?.id === contextRef || context?.name === contextRef) {
      return context
    }
  }
  throw new QueryError(`错误: 上下文不存在：${contextRef}`)
}

async function resolveNodeRef(nodeRef, fieldName = 'node') {
  const resolved = await resolveNode(nodeRef)
  if (!resolved?.detail?.id) {
    throw new QueryError(`错误: 无法解析 ${fieldName}`)
  }
  return resolved.detail.id
}

function normalizeFilterText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function inferMiddleLabel(payload) {
  if (payload.middleLabel !== undefined && payload.middleLabel !== null) {
    return String(payload.middleLabel)
  }
  if (typeof payload.label === 'string') {
    return payload.label
  }
  return ''
}

async function listRelations(filters) {
  const params = {}
  const sourceRef = pickFirstString(filters, ['sourceId', 'sourceName', 'source'])
  const targetRef = pickFirstString(filters, ['targetId', 'targetName', 'target'])
  const middleRef = pickFirstString(filters, ['middleId', 'middleName', 'middle'])
  const relationType = pickFirstString(filters, ['relationType', 'type'])
  const label = normalizeFilterText(filters?.label)
  const middleLabel = normalizeFilterText(filters?.middleLabel)

  if (sourceRef) {
    params.sourceId = await resolveNodeRef(sourceRef, 'source')
  }
  if (targetRef) {
    params.targetId = await resolveNodeRef(targetRef, 'target')
  }
  if (middleRef) {
    params.middleId = await resolveNodeRef(middleRef, 'middle')
  }

  if (!params.sourceId && !params.targetId && !params.middleId) {
    throw new QueryError('list-relations 至少需要 source、target 或 middle 中的一个条件')
  }

  const data = await apiGet('/relations', params)
  if (!Array.isArray(data)) {
    throw new QueryError('无法解析关系列表结果')
  }

  return data.filter((relation) => {
    if (relationType && relation?.relationType !== relationType) {
      return false
    }
    if (label && (relation?.label || '') !== label) {
      return false
    }
    if (middleLabel && (relation?.middleLabel || '') !== middleLabel) {
      return false
    }
    return true
  })
}

async function createNodeFromPayload(payload) {
  const contextRef = pickFirstString(payload, ['boundedContextId', 'boundedContextName', 'boundedContext'])
  const boundedContextId = contextRef ? (await resolveContextRef(contextRef)).id : null
  const normalized = normalizeEnumLikeProperties(
    Array.isArray(payload.properties) ? payload.properties : [],
    Array.isArray(payload.rules) ? payload.rules : []
  )
  return apiPost('/nodes', {
    boundedContextId,
    name: payload.name,
    type: payload.type,
    properties: normalized.properties,
    rules: normalized.rules,
    displayName: payload.displayName ?? null,
  })
}

async function updateNodeFromPayload(nodeRef, payload) {
  const contextRef = pickFirstString(payload, ['boundedContextId', 'boundedContextName', 'boundedContext'])
  if (contextRef) {
    throw new QueryError('update-node 不支持修改限界上下文；请改用 move-node <nodeNameOrId> <targetContextNameOrId>')
  }
  const resolved = await resolveNode(nodeRef)
  const nextPayload = omitKeys(payload, ['id', 'nodeId', 'nodeName', 'node'])
  if (nextPayload.properties !== undefined || nextPayload.rules !== undefined) {
    const normalized = normalizeEnumLikeProperties(
      Array.isArray(nextPayload.properties) ? nextPayload.properties : [],
      Array.isArray(nextPayload.rules) ? nextPayload.rules : []
    )
    if (nextPayload.properties !== undefined) {
      nextPayload.properties = normalized.properties
    }
    if (nextPayload.rules !== undefined || normalized.notes.length > 0) {
      nextPayload.rules = normalized.rules
    }
  }
  return apiPut(`/nodes/${resolved.detail.id}`, nextPayload)
}

async function moveNodeToBoundedContext(nodeRef, contextRef) {
  const resolved = await resolveNode(nodeRef)
  const targetContext = await resolveContextRef(contextRef)
  return apiPost(`/nodes/${resolved.detail.id}/move-to-bounded-context`, {
    targetBoundedContextId: targetContext.id,
  })
}

async function deleteNodeByRef(nodeRef) {
  const resolved = await resolveNode(nodeRef)
  return apiDelete(`/nodes/${resolved.detail.id}`)
}

async function createRelationFromPayload(payload) {
  const sourceId = await resolveNodeRef(pickFirstString(payload, ['sourceId', 'sourceName', 'source']), 'source')
  const targetId = await resolveNodeRef(pickFirstString(payload, ['targetId', 'targetName', 'target']), 'target')
  const middleRef = pickFirstString(payload, ['middleId', 'middleName', 'middle'])
  const middleId = middleRef ? await resolveNodeRef(middleRef, 'middle') : undefined
  return apiPost('/relations', {
    sourceId,
    targetId,
    relationType: payload.relationType ?? payload.type,
    label: payload.label ?? '',
    metadata: payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {},
    middleId,
    middleLabel: middleId ? inferMiddleLabel(payload) : undefined,
  })
}

async function updateRelationFromPayload(relationId, payload) {
  const nextPayload = omitKeys(payload, ['id', 'relationId'])
  const sourceRef = pickFirstString(payload, ['sourceId', 'sourceName', 'source'])
  const targetRef = pickFirstString(payload, ['targetId', 'targetName', 'target'])
  const middleRef = pickFirstString(payload, ['middleId', 'middleName', 'middle'])

  if (sourceRef) {
    nextPayload.sourceId = await resolveNodeRef(sourceRef, 'source')
  }
  if (targetRef) {
    nextPayload.targetId = await resolveNodeRef(targetRef, 'target')
  }
  if (middleRef) {
    nextPayload.middleId = await resolveNodeRef(middleRef, 'middle')
    if (nextPayload.middleLabel === undefined) {
      nextPayload.middleLabel = inferMiddleLabel(payload)
    }
  }
  if (payload.relationType === undefined && payload.type !== undefined) {
    nextPayload.relationType = payload.type
  }

  delete nextPayload.sourceName
  delete nextPayload.source
  delete nextPayload.targetName
  delete nextPayload.target
  delete nextPayload.middleName
  delete nextPayload.middle
  delete nextPayload.type

  return apiPut(`/relations/${relationId}`, nextPayload)
}

async function deleteRelationById(relationId) {
  return apiDelete(`/relations/${relationId}`)
}

function displayName(node, fallback = '') {
  if (!node) {
    return fallback
  }
  return node.displayName || node.name || fallback
}

function formatNodeLabel(node) {
  const name = node?.name || ''
  const shown = displayName(node, name)
  return shown === name ? shown : `${shown}（${name}）`
}

function summarizeContexts(contexts) {
  const names = contexts.map((item) => item?.name).filter(Boolean)
  let preview = names.slice(0, 6).join('、')
  if (names.length > 6) {
    preview += ' 等'
  }

  const lines = [
    '结果：',
    `- 当前项目一共划分了 ${names.length} 个上下文，职责已经按 ${preview} 这些方向拆开。`,
    '',
    '补充说明：',
    `- 上下文列表：${names.join('、')}`,
  ]

  const observations = []
  if (names.includes('OrderContext') && names.includes('UserContext')) {
    observations.push('订单和用户职责是分开的，适合分别理解下单链路和账户行为。')
  }
  if (names.includes('TeamContext') && names.includes('AdminContext')) {
    observations.push('团队协作和后台管理也单独成了边界。')
  }
  for (const item of observations.slice(0, 2)) {
    lines.push(`- ${item}`)
  }

  if (names.includes('OrderContext')) {
    lines.push('- 如果你想先看主业务流程，建议先从 OrderContext 开始。')
  } else if (names.length) {
    lines.push(`- 如果你想继续展开，建议先从 ${names[0]} 开始。`)
  }

  return lines.join('\n')
}

function summarizeContext(contextName, nodes) {
  const counter = new Map()
  for (const node of nodes) {
    const type = node?.type || 'Unknown'
    counter.set(type, (counter.get(type) || 0) + 1)
  }
  const ordered = [...counter.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
  const keyExamples = nodes
    .slice(0, 6)
    .map((node) => (node?.name ? displayName(node, node.name) : ''))
    .filter(Boolean)
  const topTypes = ordered.slice(0, 4).map(([name, count]) => `${name} ${count} 个`).join('、')

  const lines = [
    '结果：',
    `- ${contextName} 当前共有 ${nodes.length} 个节点，主要由 ${topTypes} 构成。`,
  ]
  if (keyExamples.length) {
    lines.push(`- 这里的核心内容大致围绕 ${keyExamples.slice(0, 4).join('、')} 这些业务对象和动作展开。`)
  }

  lines.push('', '补充说明：')
  if (ordered.length) {
    lines.push(`- 类型分布：${ordered.map(([name, count]) => `${name} ${count} 个`).join('；')}`)
  }

  const priorityOrder = ['Aggregate', 'Command', 'Event', 'Policy', 'Timer', 'System']
  const focusNodes = []
  for (const nodeType of priorityOrder) {
    for (const node of nodes) {
      if (node?.type === nodeType) {
        focusNodes.push(formatNodeLabel(node))
      }
      if (focusNodes.length >= 6) {
        break
      }
    }
    if (focusNodes.length >= 6) {
      break
    }
  }

  if (focusNodes.length) {
    lines.push(`- 关键节点：${focusNodes.join('、')}`)
  }

  if ((counter.get('Aggregate') || 0) > 0) {
    lines.push('- 理解这个上下文时，可以先看聚合和命令的关系，再看事件如何往后传播。')
  } else if ((counter.get('Command') || 0) > 0) {
    lines.push('- 理解这个上下文时，可以先沿着主要命令看它们会产出哪些事件。')
  } else {
    lines.push('- 理解这个上下文时，可以先从关键节点往前后各追一层关系。')
  }

  return lines.join('\n')
}

function buildRelationSentence(rootDisplay, direction, commands, events, policies) {
  if (direction === 'incoming') {
    if (events.length && commands.length) {
      return `${events[0]}后，会经过${commands[0]}，最终产生${rootDisplay}。`
    }
    if (commands.length) {
      return `${commands[0]}会触发${rootDisplay}。`
    }
    if (events.length) {
      return `${events[0]}会继续流转，最终产生${rootDisplay}。`
    }
    return `当前结果主要是在解释${rootDisplay}是如何被触发出来的。`
  }

  if (events.length && commands.length) {
    return `${rootDisplay}后，会继续触发${events[0]}，并执行${commands[0]}。`
  }
  if (events.length) {
    return `${rootDisplay}后，会继续影响${events[0]}。`
  }
  if (commands.length) {
    return `${rootDisplay}后，会继续驱动${commands[0]}。`
  }
  if (policies.length) {
    return `${rootDisplay}后，会先进入${policies[0]}这类规则处理。`
  }
  return `当前结果主要是在解释${rootDisplay}之后的后续动作。`
}

function summarizeRelations(data) {
  const root = data.root || ''
  const rootContext = data.rootContext || ''
  const direction = data.direction || 'outgoing'
  const nodes = data.nodes || {}
  const edges = data.edges || []
  const rootNode = nodes[root] || {}
  const rootDisplay = displayName(rootNode, root)

  const commands = []
  const policies = []
  const events = []
  const crossContextByContext = new Map()

  for (const [name, node] of Object.entries(nodes)) {
    if (name === root) {
      continue
    }
    const label = formatNodeLabel(node)
    if (node?.type === 'Command') {
      commands.push(label)
    } else if (node?.type === 'Policy') {
      policies.push(label)
    } else if (node?.type === 'Event') {
      events.push(label)
    }

    if (name.includes('.')) {
      const contextName = name.split('.', 1)[0]
      const current = crossContextByContext.get(contextName) || []
      current.push(label)
      crossContextByContext.set(contextName, current)
    }
  }

  const lines = [
    '结果：',
    `- ${buildRelationSentence(rootDisplay, direction, commands, events, policies)}`,
    '',
    '补充说明：',
    `- 当前查看的是 ${rootDisplay}（${root}），位于 ${rootContext}。`,
  ]

  if (direction === 'incoming') {
    if (commands.length) {
      lines.push(`- 直接相关动作：${commands.slice(0, 4).join('、')}`)
    }
    if (events.length) {
      lines.push(`- 上游事件：${events.slice(0, 4).join('、')}`)
    }
  } else {
    if (commands.length) {
      lines.push(`- 后续动作：${commands.slice(0, 4).join('、')}`)
    }
    if (events.length) {
      lines.push(`- 后续结果：${events.slice(0, 4).join('、')}`)
    }
  }

  if (policies.length) {
    lines.push(`- 规则处理：${policies.slice(0, 3).join('、')}`)
  }

  if (crossContextByContext.size) {
    const preview = [...crossContextByContext.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 4)
      .map(([context, items]) => `${context}: ${items.slice(0, 3).join('、')}`)
      .join('；')
    lines.push(`- 跨上下文影响：${preview}`)
  } else {
    lines.push('- 当前结果没有明显的跨上下文节点。')
  }

  if (edges.length) {
    const preview = edges
      .slice(0, 4)
      .map((edge) => `${edge?.from || '?'} -> ${edge?.to || '?'}`)
      .join('；')
    lines.push(`- 技术链路补充：${preview}`)
  } else {
    lines.push('- 技术链路补充：当前没有查到显式关系边。')
  }

  if (SUMMARY_STYLE === 'review') {
    if (crossContextByContext.size) {
      lines.push('- 这条链路已经跨出当前上下文，后续改动前建议继续确认外部影响。')
    } else if (policies.length) {
      lines.push('- 这条链路包含策略节点，评审时要特别留意规则是否分散。')
    }
  } else if (direction === 'incoming') {
    lines.push('- 如果你还想继续展开，可以再往前看最靠近的上游事件或命令。')
  } else {
    lines.push('- 如果你还想继续展开，可以再追后续事件或命令的下游。')
  }

  return lines.join('\n')
}

function usage() {
  return 'Usage: node scripts/domain-model-query.mjs <auth-init|auth-login|auth-login-browser|auth-status|list-contexts|context-nodes|node-detail|node-relations|summarize-contexts|summarize-context|summarize-relations|list-relations|create-node|update-node|move-node|delete-node|create-relation|update-relation|delete-relation> [args...]'
}

function parseBool(value, defaultValue = false) {
  if (value === '') {
    return defaultValue
  }
  return String(value).toLowerCase() === 'true'
}

function authStatus() {
  const tokenInfo = getTokenInfo()
  const lines = [
    '结果：',
    `- 当前认证模式：${authModeLabel()}。`,
    '',
    '补充说明：',
    `- 配置文件：${CONFIG_PATH}`,
    `- 查询 API：${BASE_URL}`,
    `- 项目范围：${PROJECT_ID || '未配置'}`,
    `- 用户态令牌：${hasUserToken() ? '已配置' : '未配置'}`,
  ]

  if (tokenInfo) {
    lines.push(`- 令牌权限：${formatPermissionSummary(tokenInfo)}`)
    lines.push(`- 令牌项目：${tokenInfo.projectId || '未声明'}`)
    lines.push(`- 令牌过期时间：${formatTokenExpiry(tokenInfo)}`)
    lines.push(`- 令牌状态：${tokenInfo.isExpired ? '已过期' : '可复用'}`)
  }

  if (hasUserToken()) {
    lines.push('- 当前默认会优先复用已有用户态查询令牌。')
  } else {
    lines.push('- 下一步建议：先执行 auth-init，再执行 auth-login-browser。')
  }
  return lines.join('\n')
}

function runAuthInit(argv) {
  let projectId
  let baseUrl = BASE_URL

  if (argv.length > 2) {
    const first = argv[2]
    if (first.startsWith('http://') || first.startsWith('https://')) {
      baseUrl = first
    } else {
      projectId = first
      if (argv.length > 3) {
        baseUrl = argv[3]
      }
    }
  }

  const config = buildLocalConfigUpdates({ projectId, baseUrl })
  writeLocalConfig(config)
  return [
    '结果：',
    `- 已写入基础配置，默认项目是 ${projectId || '未指定'}。`,
    '',
    '补充说明：',
    `- 查询 API：${baseUrl.replace(/\/$/, '')}`,
    projectId
      ? `- 手动模式：在已登录浏览器里访问 ${authLoginUrl(baseUrl, projectId)}`
      : '- 手动模式：如果你想跳过浏览器选项目，可以稍后手动指定 projectId 再申请 token。',
    '- 推荐模式：直接执行 auth-login-browser，让脚本自动打开浏览器并保存令牌。',
  ].join('\n')
}

function runAuthLogin(argv) {
  if (argv.length < 3) {
    throw new QueryError('Usage: node scripts/domain-model-query.mjs auth-login <accessToken> [projectId] [baseUrl]')
  }
  const accessToken = argv[2]
  const projectId = argv[3] || PROJECT_ID || undefined
  const baseUrl = argv[4] || BASE_URL
  const config = buildLocalConfigUpdates({ accessToken, projectId, baseUrl })
  writeLocalConfig(config)
  return [
    '结果：',
    `- 已保存用户态查询令牌，当前默认项目是 ${projectId || '未配置'}。`,
    '',
    '补充说明：',
    `- 配置文件：${CONFIG_PATH}`,
    '- 后续查询会使用用户态令牌。',
    '- 如果你要切项目，可以重新执行 auth-init 覆盖项目范围。',
  ].join('\n')
}

function openBrowser(url) {
  try {
    const command =
      process.platform === 'darwin'
        ? { cmd: 'open', args: [url] }
        : process.platform === 'win32'
          ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
          : { cmd: 'xdg-open', args: [url] }

    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runAuthLoginBrowser(argv) {
  const projectId = argv[2] || PROJECT_ID || undefined
  const baseUrl = argv[3] || BASE_URL
  const permission = argv[4] || DEFAULT_AUTH_PERMISSION
  if (!['read', 'write'].includes(permission)) {
    throw new QueryError('Usage: node scripts/domain-model-query.mjs auth-login-browser [projectId] [baseUrl] [read|write] [expiresInSeconds]')
  }
  const expiresIn = argv[5] ? Number.parseInt(argv[5], 10) : DEFAULT_AUTH_EXPIRES_IN_SECONDS
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
    throw new QueryError('expiresInSeconds 必须是正整数秒数')
  }

  const reuse = canReuseCurrentToken({
    requestedProjectId: projectId,
    requiredPermission: permission,
  })
  if (reuse.reusable) {
    const config = buildLocalConfigUpdates({
      projectId: projectId || reuse.tokenInfo?.projectId || PROJECT_ID,
      accessToken: ACCESS_TOKEN,
      baseUrl,
    })
    writeLocalConfig(config)
    return [
      '结果：',
      `- 已复用现有查询令牌，当前默认项目是 ${config.projectId || '未配置'}。`,
      '',
      '补充说明：',
      `- 配置文件：${CONFIG_PATH}`,
      `- 当前权限：${formatPermissionSummary(reuse.tokenInfo)}`,
      `- 令牌过期时间：${formatTokenExpiry(reuse.tokenInfo)}`,
      '- 本次未重新打开浏览器授权。',
    ].join('\n')
  }

  const sessionId = randomHex(32)
  const startUrl = authBrowserStartUrl(baseUrl, sessionId, projectId, permission, expiresIn)
  const completeUrl = authBrowserCompleteUrl(baseUrl, sessionId)

  const opened = openBrowser(startUrl)
  if (!opened) {
    console.error('未能自动打开浏览器，请手动访问：')
    console.error(startUrl)
  }

  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const payload = await fetchJsonAbsolute(completeUrl)
    const data = payload.data || {}
    const status = data.status

    if (status === 'completed') {
      const result = data.result || {}
      const accessToken = result.accessToken
      const resolvedProjectId = result.projectId || projectId
      if (!accessToken) {
        throw new QueryError('浏览器认证已完成，但没有拿到 access token')
      }
      const config = buildLocalConfigUpdates({
        accessToken,
        projectId: resolvedProjectId,
        baseUrl,
      })
      writeLocalConfig(config)
      return [
        '结果：',
        `- 浏览器认证已完成，当前默认项目是 ${resolvedProjectId || '未配置'}。`,
        '',
        '补充说明：',
        `- 配置文件：${CONFIG_PATH}`,
        '- 查询令牌已经自动写入本地配置。',
        `- 本次重新授权原因：${reuse.reason}。`,
        '- 后续查询会优先复用当前用户态令牌。',
      ].join('\n')
    }

    if (status === 'failed') {
      const error = data.error || {}
      const message = typeof error === 'object' ? error.message : String(error)
      throw new QueryError(message || '浏览器认证失败')
    }

    await sleep(2000)
  }

  throw new QueryError('浏览器认证超时。请重新执行 auth-login-browser，并在 5 分钟内完成登录。')
}

async function main(argv) {
  if (argv.length < 3 && !argv[2]) {
    throw new QueryError(usage())
  }

  const command = argv[2]

  if (command === 'auth-status') {
    console.log(authStatus())
    return 0
  }

  if (command === 'auth-init') {
    console.log(runAuthInit(argv.slice(1)))
    return 0
  }

  if (command === 'auth-login') {
    console.log(runAuthLogin(argv.slice(1)))
    return 0
  }

  if (command === 'auth-login-browser') {
    console.log(await runAuthLoginBrowser(argv.slice(1)))
    return 0
  }

  requireAuthConfig()

  if (command === 'list-contexts') {
    jsonDump(await getContexts())
    return 0
  }

  if (command === 'summarize-contexts') {
    console.log(summarizeContexts(await getContexts()))
    return 0
  }

  if (command === 'context-nodes') {
    if (argv.length < 4) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs context-nodes <contextName> [name] [includeProperties] [includeRules]')
    }
    const contextName = argv[3]
    const nameFilter = argv[4] || ''
    const includeProperties = argv.length > 5 ? parseBool(argv[5], false) : false
    const includeRules = argv.length > 6 ? parseBool(argv[6], false) : false
    jsonDump(await getContextNodes(contextName, nameFilter, includeProperties, includeRules))
    return 0
  }

  if (command === 'summarize-context') {
    if (argv.length < 4) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs summarize-context <contextName> [name] [includeProperties] [includeRules]')
    }
    const contextName = argv[3]
    const nameFilter = argv[4] || ''
    const includeProperties = argv.length > 5 ? parseBool(argv[5], false) : false
    const includeRules = argv.length > 6 ? parseBool(argv[6], false) : false
    console.log(summarizeContext(contextName, await getContextNodes(contextName, nameFilter, includeProperties, includeRules)))
    return 0
  }

  if (command === 'node-detail') {
    if (argv.length < 4) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs node-detail <nodeName>')
    }
    const resolved = await resolveNode(argv[3])
    jsonDump(resolved.detail)
    return 0
  }

  if (command === 'node-relations') {
    if (argv.length < 4) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs node-relations <nodeName> [outgoing|incoming] [context|global] [Event,Command]')
    }
    const nodeName = argv[3]
    const direction = argv[4] || 'outgoing'
    const scope = argv[5] || 'context'
    const nodeTypes = argv[6] || 'Event'
    jsonDump(await getNodeRelations(nodeName, direction, scope, nodeTypes))
    return 0
  }

  if (command === 'summarize-relations') {
    if (argv.length < 4) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs summarize-relations <nodeName> [outgoing|incoming] [context|global] [Event,Command]')
    }
    const nodeName = argv[3]
    const direction = argv[4] || 'outgoing'
    const scope = argv[5] || 'context'
    const nodeTypes = argv[6] || 'Event'
    console.log(summarizeRelations(await getNodeRelations(nodeName, direction, scope, nodeTypes)))
    return 0
  }

  if (command === 'list-relations') {
    if (argv.length < 4) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs list-relations <jsonFilters>')
    }
    jsonDump(await listRelations(parseJsonArg(argv[3], 'list-relations payload')))
    return 0
  }

  if (command === 'create-node') {
    if (argv.length < 4) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs create-node <jsonPayload>')
    }
    jsonDump(await createNodeFromPayload(parseJsonArg(argv[3], 'create-node payload')))
    return 0
  }

  if (command === 'update-node') {
    if (argv.length < 5) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs update-node <nodeNameOrId> <jsonPayload>')
    }
    jsonDump(await updateNodeFromPayload(argv[3], parseJsonArg(argv[4], 'update-node payload')))
    return 0
  }

  if (command === 'move-node') {
    if (argv.length < 5) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs move-node <nodeNameOrId> <targetContextNameOrId>')
    }
    jsonDump(await moveNodeToBoundedContext(argv[3], argv[4]))
    return 0
  }

  if (command === 'delete-node') {
    if (argv.length < 4) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs delete-node <nodeNameOrId>')
    }
    jsonDump(await deleteNodeByRef(argv[3]))
    return 0
  }

  if (command === 'create-relation') {
    if (argv.length < 4) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs create-relation <jsonPayload>')
    }
    jsonDump(await createRelationFromPayload(parseJsonArg(argv[3], 'create-relation payload')))
    return 0
  }

  if (command === 'update-relation') {
    if (argv.length < 5) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs update-relation <relationId> <jsonPayload>')
    }
    jsonDump(await updateRelationFromPayload(argv[3], parseJsonArg(argv[4], 'update-relation payload')))
    return 0
  }

  if (command === 'delete-relation') {
    if (argv.length < 4) {
      throw new QueryError('Usage: node scripts/domain-model-query.mjs delete-relation <relationId>')
    }
    jsonDump(await deleteRelationById(argv[3]))
    return 0
  }

  throw new QueryError(`Unknown command: ${command}`)
}

try {
  await main(process.argv)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
