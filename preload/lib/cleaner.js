'use strict'

/**
 * 重复文件清理引擎：插件中唯一会移除被扫描文件的模块。
 *
 * 安全约束（按执行顺序，并发化后一条都没有放宽）：
 *  1. 删除清单只从 preload 自己保存的 ScanResult 生成。界面只能提交
 *     groupIds / keepOverrides / mode / excludedIndices（组内索引，不是路径），
 *     不能提交任意文件路径。
 *  2. 每组先验证「保留文件」仍存在且内容一致，否则整组跳过，绝不删光所有副本。
 *  3. 每个待删文件在删除前重新做全文件 SHA-256 复核（复用 scanner.fullHash），
 *     必须与该组 hash 一致，且大小、类型与扫描时一致。
 *  4. 只删除普通文件：符号链接、目录、与保留项同一 inode 的硬链接一律跳过；
 *     被其他组指定为保留项的路径也跳过。
 *  5. 无权限 / 被占用 / 内容变化 / 文件消失 / 删除失败均跳过并记录原因，不中断整体。
 *  6. 本模块不直接调用 uTools 系统 API，实际移除动作由 options.removeItem 或
 *     options.removeItemBatch 注入，便于在 Node 环境下审计与回归测试。
 *
 * 性能模型（v2）：以 concurrency 为一批，批内并发完成「全文件 SHA-256 复核」，
 * 紧接着对该批通过的文件一次性批量移除并统一做存在性确认。
 * 复核与删除紧邻，TOCTOU 窗口最短；既不重复哈希，也不跳过任何一项校验。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const { AppError, comparablePath, CLEAN_REASON_DEFS } = require('./schema.js')
const { fullHash } = require('./scanner.js')

const HASH_RE = /^[0-9a-f]{64}$/
const MAX_SELECTED_GROUPS = 5000
const DEFAULT_CONCURRENCY = 8
const MAX_CONCURRENCY = 32

const REASON_LABELS = Object.fromEntries(CLEAN_REASON_DEFS.map((r) => [r.code, r.label]))

/** 并发数校验：界面可调，但严格限制在 1~32，避免开太多文件句柄 */
function normalizeConcurrency(value) {
  const n = value === undefined || value === null || value === '' ? DEFAULT_CONCURRENCY : Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < 1 || n > MAX_CONCURRENCY) {
    throw new AppError('INVALID_CONFIG', `并发数必须在 1 ~ ${MAX_CONCURRENCY} 之间`)
  }
  return n
}

function failItem(filePath, groupId, size, reason, message, errorCode) {
  return {
    path: filePath,
    groupId,
    size: size === undefined || size === null ? null : size,
    reason,
    label: REASON_LABELS[reason] || reason,
    message,
    errorCode: errorCode || null,
  }
}

/**
 * 校验并归一化界面提交的清理选择，生成稳定的 selectionKey。
 * selectionKey 只绑定 groupIds / keepOverrides / mode：excludedIndices 只可能
 * 「少删」，不会引入任何新路径，因此不进入 key，用户取消勾选无需重新确认。
 */
function canonicalSelection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('INVALID_SELECTION', '清理选择必须是对象')
  }
  if (!Array.isArray(raw.groupIds)) {
    throw new AppError('INVALID_SELECTION', 'groupIds 必须是字符串数组')
  }
  const groupIds = []
  const seen = new Set()
  for (const id of raw.groupIds) {
    const s = String(id === undefined || id === null ? '' : id).trim()
    if (!s) throw new AppError('INVALID_SELECTION', 'groupIds 不能包含空值')
    if (!seen.has(s)) {
      seen.add(s)
      groupIds.push(s)
    }
  }
  if (groupIds.length === 0) {
    throw new AppError('NO_GROUPS_SELECTED', '请至少选择一个重复组')
  }
  if (groupIds.length > MAX_SELECTED_GROUPS) {
    throw new AppError('INVALID_SELECTION', `一次最多清理 ${MAX_SELECTED_GROUPS} 个重复组`)
  }

  const rawOverrides = raw.keepOverrides === undefined || raw.keepOverrides === null ? {} : raw.keepOverrides
  if (typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
    throw new AppError('INVALID_SELECTION', 'keepOverrides 必须是对象')
  }
  const keepOverrides = {}
  for (const key of Object.keys(rawOverrides)) {
    const value = rawOverrides[key]
    if (typeof value !== 'string' || !value.trim()) {
      throw new AppError('INVALID_SELECTION', `keepOverrides.${key} 必须是非空路径字符串`)
    }
    keepOverrides[String(key).trim()] = value
  }

  // 文件级批量选择：只允许传「组内待删清单的索引」，绝不接收路径
  const rawExcluded = raw.excludedIndices === undefined || raw.excludedIndices === null ? {} : raw.excludedIndices
  if (typeof rawExcluded !== 'object' || Array.isArray(rawExcluded)) {
    throw new AppError('INVALID_SELECTION', 'excludedIndices 必须是对象')
  }
  const excludedIndices = {}
  for (const key of Object.keys(rawExcluded)) {
    const list = rawExcluded[key]
    if (!Array.isArray(list)) {
      throw new AppError('INVALID_SELECTION', `excludedIndices.${key} 必须是索引数组`)
    }
    const set = new Set()
    for (const v of list) {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0) {
        throw new AppError('INVALID_SELECTION', `excludedIndices.${key} 只能包含非负整数索引`)
      }
      set.add(n)
    }
    if (set.size > 0) excludedIndices[String(key).trim()] = Array.from(set).sort((a, b) => a - b)
  }

  const mode = raw.mode === undefined ? 'trash' : raw.mode
  if (mode !== 'trash' && mode !== 'permanent') {
    throw new AppError('INVALID_CLEAN_MODE', 'mode 只能是 trash 或 permanent')
  }

  const selection = { groupIds, keepOverrides, mode, excludedIndices }
  const sortedOverrides = Object.keys(keepOverrides)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => [k, keepOverrides[k]])
  selection.key = JSON.stringify({
    groupIds: groupIds.slice().sort(),
    keepOverrides: Object.fromEntries(sortedOverrides),
    mode,
  })
  return selection
}

function assertScanResult(result) {
  if (!result || typeof result !== 'object') {
    throw new AppError('SCAN_RESULT_NOT_FOUND', '找不到对应的扫描结果，请重新扫描')
  }
  if (typeof result.scanId !== 'string' || !result.scanId || !Array.isArray(result.groups)) {
    throw new AppError('SCAN_RESULT_NOT_FOUND', '扫描结果已失效，请重新扫描')
  }
}

/** 供预览与清理报告展示的扫描范围快照（来自生效配置，不接受界面输入） */
function makeScope(result) {
  const c = result.config || {}
  const rulesToText = (rules) =>
    (Array.isArray(rules) ? rules : [])
      .map((r) => (r && typeof r === 'object' && typeof r.raw === 'string' ? r.raw : String(r)))
      .filter(Boolean)
  return {
    scanId: result.scanId,
    scanStatus: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    roots: Array.isArray(c.roots) ? c.roots.slice() : [],
    recursive: c.recursive !== false,
    includeDirs: rulesToText(c.includeDirs),
    excludeDirs: rulesToText(c.excludeDirs),
    extensions: Array.isArray(c.extensions) ? c.extensions.slice() : [],
    minSize: Number(c.minSize) || 0,
    maxSize: c.maxSize === null || c.maxSize === undefined ? null : Number(c.maxSize),
    excludeHidden: c.excludeHidden !== false,
    followSymlinks: Boolean(c.followSymlinks),
    hashAlgorithm: 'sha256',
  }
}

/**
 * 生成冻结的清理预览计划（纯计算，不触碰文件系统）。
 * excludedIndices 只做「从已确认清单中排除」，索引必须落在预览清单范围内。
 * @param {object} result preload 内保存的 ScanResult
 * @param {object} rawSelection 界面提交的选择
 * @param {Set<string>} cleanedIds 本次扫描已清理过的组
 */
function buildCleanPlan(result, rawSelection, cleanedIds) {
  assertScanResult(result)
  const selection = canonicalSelection(rawSelection)
  const done = cleanedIds instanceof Set ? cleanedIds : new Set(Array.isArray(cleanedIds) ? cleanedIds : [])
  const byId = new Map(result.groups.map((g) => [g.groupId, g]))
  const warnings = []
  const groups = []
  let alreadyCleaned = 0
  let allExcluded = 0

  if (result.status !== 'done') {
    warnings.push(`本次扫描状态为 ${result.status}（部分结果）：清理清单只包含已列出的重复组，建议重新完整扫描后再清理`)
  }

  for (const id of selection.groupIds) {
    if (done.has(id)) {
      alreadyCleaned += 1
      warnings.push(`${id} 在本次扫描中已清理过，已自动跳过`)
      continue
    }
    const g = byId.get(id)
    if (!g) throw new AppError('INVALID_SELECTION', `重复组不存在：${id}`)
    if (!Array.isArray(g.files) || g.files.length < 2 || g.count !== g.files.length) {
      throw new AppError('INVALID_SELECTION', `${id} 的组内文件清单不完整，拒绝清理`)
    }
    if (!HASH_RE.test(String(g.hash || ''))) {
      throw new AppError('INVALID_SELECTION', `${id} 缺少有效的 SHA-256 内容哈希，拒绝清理`)
    }
    if (!Number.isInteger(g.size) || g.size <= 0) {
      throw new AppError('INVALID_SELECTION', `${id} 的文件大小无效（空文件不参与清理）`)
    }
    if (g.files.some((f) => f.status !== 'OK' || f.size !== g.size || !path.isAbsolute(f.path))) {
      throw new AppError('INVALID_SELECTION', `${id} 含状态异常或路径非法的文件，拒绝清理`)
    }
    const keys = g.files.map((f) => comparablePath(f.path))
    if (new Set(keys).size !== keys.length) {
      throw new AppError('INVALID_SELECTION', `${id} 含重复路径，拒绝清理`)
    }

    const override = selection.keepOverrides[id]
    let keepPath = g.keepSuggestion ? g.keepSuggestion.path : null
    if (override !== undefined) {
      const hit = g.files.find((f) => comparablePath(f.path) === comparablePath(override))
      if (!hit) throw new AppError('INVALID_SELECTION', `${id} 指定的保留项不在该组文件清单内`)
      keepPath = hit.path
    }
    if (!keepPath || !g.files.some((f) => comparablePath(f.path) === comparablePath(keepPath))) {
      throw new AppError('INVALID_SELECTION', `${id} 缺少有效保留项，请在预览中手动指定保留文件`)
    }

    const keepFile = g.files.find((f) => comparablePath(f.path) === comparablePath(keepPath))
    const candidates = g.files
      .filter((f) => comparablePath(f.path) !== comparablePath(keepPath))
      .map((f) => ({ path: f.path, size: f.size, relativePath: f.relativePath }))
    const excluded = new Set(selection.excludedIndices[id] || [])
    for (const idx of excluded) {
      if (idx >= candidates.length) {
        throw new AppError('INVALID_SELECTION', `${id} 的排除索引越界：${idx}（清单共 ${candidates.length} 项）`)
      }
    }
    const deletes = candidates.filter((_, idx) => !excluded.has(idx))
    if (deletes.length === 0) {
      allExcluded += 1
      warnings.push(`${id} 的待删除文件已全部取消勾选，已跳过该组`)
      continue
    }

    groups.push({
      groupId: id,
      hash: g.hash,
      size: g.size,
      keep: { path: keepFile.path, size: keepFile.size, relativePath: keepFile.relativePath },
      deletes,
      deleteCount: deletes.length,
      excludedCount: candidates.length - deletes.length,
      reclaimableBytes: g.size * deletes.length,
    })
  }

  if (groups.length === 0) {
    if (allExcluded > 0 && alreadyCleaned === 0) {
      throw new AppError('NO_GROUPS_SELECTED', '所有待删除文件均已取消勾选，请至少保留一项')
    }
    throw new AppError('ALREADY_CLEANED', '所选重复组均已清理过；如需处理新增重复项请重新扫描')
  }

  const totals = {
    groupCount: groups.length,
    keepCount: groups.length,
    deleteCount: groups.reduce((n, g) => n + g.deleteCount, 0),
    reclaimableBytes: groups.reduce((n, g) => n + g.reclaimableBytes, 0),
  }
  return {
    planId: `plan-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    scanId: result.scanId,
    selectionKey: selection.key,
    mode: selection.mode,
    createdAt: Date.now(),
    scope: makeScope(result),
    groups,
    totals,
    warnings,
  }
}

/** 系统错误 -> 明确的跳过原因 */
function classifyCleanError(err, stage) {
  const code = err && err.code ? String(err.code) : 'UNKNOWN'
  const message = err && err.message ? String(err.message) : '未知错误'
  if (code === 'TRASH_FAILED') {
    return { reason: 'TRASH_FAILED', message: '移入回收站后文件仍存在（磁盘不支持回收站或文件被占用），未计入删除', errorCode: code }
  }
  if (code === 'ENOENT') {
    return { reason: 'MISSING', message: '文件在扫描后已不存在（可能已被其他程序移除）', errorCode: code }
  }
  if (code === 'EACCES') {
    return { reason: 'NO_PERMISSION', message: `无访问权限（${message}）`, errorCode: code }
  }
  if (code === 'EPERM') {
    if (stage === 'unlink' || stage === 'trash') {
      return { reason: 'FILE_IN_USE', message: `文件被占用或系统拒绝删除（${message}）`, errorCode: code }
    }
    return { reason: 'NO_PERMISSION', message: `无访问权限（${message}）`, errorCode: code }
  }
  if (code === 'EBUSY' || code === 'ETXTBSY' || code === 'EAGAIN') {
    return { reason: 'FILE_IN_USE', message: `文件正在被其他程序占用（${message}）`, errorCode: code }
  }
  if (code === 'SCAN_RACE' || code === 'UNEXPECTED_EOF') {
    return { reason: 'CHANGED_DURING_VERIFY', message: '文件在复核期间发生变化，已跳过以免误删', errorCode: code }
  }
  if (code === 'ENOTDIR' || code === 'EISDIR') {
    return { reason: 'NOT_REGULAR_FILE', message: '路径已不是普通文件', errorCode: code }
  }
  if (stage === 'unlink' || stage === 'trash') {
    return { reason: 'DELETE_FAILED', message: `删除失败（${message}）`, errorCode: code }
  }
  return { reason: 'READ_FAILED', message: `删除前复核读取失败（${message}）`, errorCode: code }
}

/**
 * 删除前对单个文件做完整复核：普通文件 -> 大小 -> 全文件 SHA-256。
 * 返回 { ok, stat } 或 { ok:false, reason, message, errorCode }。
 */
async function verifyFile(filePath, expectedSize, expectedHash) {
  let lst
  try {
    lst = await fsp.lstat(filePath)
  } catch (err) {
    const c = classifyCleanError(err, 'stat')
    return { ok: false, reason: c.reason, message: c.message, errorCode: c.errorCode }
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    return { ok: false, reason: 'NOT_REGULAR_FILE', message: '路径已不是普通文件（符号链接或目录），拒绝删除', errorCode: null }
  }
  if (lst.size !== expectedSize) {
    return {
      ok: false,
      reason: 'SIZE_CHANGED',
      message: `复核时大小 ${lst.size} 与扫描时 ${expectedSize} 不一致，拒绝删除`,
      errorCode: null,
    }
  }
  let hash
  try {
    hash = await fullHash(filePath, expectedSize)
  } catch (err) {
    const c = classifyCleanError(err, 'hash')
    return { ok: false, reason: c.reason, message: c.message, errorCode: c.errorCode }
  }
  if (hash !== expectedHash) {
    return { ok: false, reason: 'HASH_MISMATCH', message: '删除前 SHA-256 复核与该组内容哈希不一致，拒绝删除', errorCode: null }
  }
  return { ok: true, stat: lst }
}

function emptyProgress(totalFiles, concurrency) {
  return {
    phase: 'init',
    message: '准备清理…',
    totalFiles,
    processedFiles: 0,
    deletedFiles: 0,
    freedBytes: 0,
    failedFiles: 0,
    currentGroup: '',
    currentPath: '',
    verifiedFiles: 0,
    concurrency,
    batchIndex: 0,
    batchCount: 0,
    elapsedMs: 0,
  }
}

/**
 * 执行一次清理。所有待删路径来自重新构建的计划，不信任任何界面传入的路径。
 *
 * @param {object} result preload 内保存的 ScanResult
 * @param {object} rawSelection 界面提交的选择
 * @param {{
 *   removeItem?: Function,
 *   removeItemBatch?: Function,
 *   concurrency?: number,
 *   onProgress?: Function,
 *   isCancelled?: Function,
 *   cleanedIds?: Set<string>
 * }} options
 * @returns {Promise<object>} CleanResult（字段定义见 schema.js 的 CLEAN_RESULT_SCHEMA）
 */
async function executeClean(result, rawSelection, options = {}) {
  assertScanResult(result)
  const selection = canonicalSelection(rawSelection)
  const plan = buildCleanPlan(result, selection, options.cleanedIds)
  if (typeof options.removeItem !== 'function' && typeof options.removeItemBatch !== 'function') {
    throw new AppError('CLEAN_CRASH', '缺少安全移除器，拒绝执行清理')
  }
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const concurrency = normalizeConcurrency(options.concurrency)

  const startedAt = Date.now()
  const cleanId = `clean-${startedAt}-${crypto.randomBytes(3).toString('hex')}`
  const totalFiles = plan.totals.deleteCount
  const progress = emptyProgress(totalFiles, concurrency)
  const report = (phase, message) => {
    progress.phase = phase
    progress.message = message
    progress.elapsedMs = Date.now() - startedAt
    onProgress(Object.assign({}, progress))
  }

  // 全局保护：任一组的保留项都不允许被当作另一组的待删文件删除
  const allKeepKeys = new Set(plan.groups.map((g) => comparablePath(g.keep.path)))
  const failures = []
  const errors = []
  const groupState = new Map()
  for (const g of plan.groups) {
    groupState.set(g.groupId, {
      groupId: g.groupId,
      hash: g.hash,
      size: g.size,
      keepPath: g.keep.path,
      planned: g.deleteCount,
      deleted: 0,
      skipped: 0,
      freedBytes: 0,
      deletedPaths: [],
      skippedPaths: [],
      skipReason: null,
      failures: [],
    })
  }

  let deletedFiles = 0
  let freedBytes = 0
  let skippedFiles = 0
  let processed = 0
  let processedTasks = 0
  let cancelled = false

  /** 阶段 1：并发验证所有组的保留项，每组只做一次全文件哈希 */
  const keepChecks = new Map()
  if (isCancelled()) {
    cancelled = true
  } else {
    report('verifying', `批量复核 ${plan.groups.length} 组的保留项（并发 ${concurrency}）…`)
    for (let i = 0; i < plan.groups.length; i += concurrency) {
      if (isCancelled()) {
        cancelled = true
        break
      }
      const slice = plan.groups.slice(i, i + concurrency)
      const checks = await Promise.all(
        slice.map(async (g) => ({ id: g.groupId, check: await verifyFile(g.keep.path, g.size, g.hash) })),
      )
      for (const c of checks) keepChecks.set(c.id, c.check)
    }
  }

  if (!cancelled) {
    for (const g of plan.groups) {
      const check = keepChecks.get(g.groupId)
      if (!check || !check.ok) {
        const message = check ? check.message : '清理已中止，未完成保留项复核'
        const item = failItem(
          g.keep.path,
          g.groupId,
          g.size,
          'KEEP_UNVERIFIED',
          `保留文件不可用（${message}）；${g.groupId} 的 ${g.deleteCount} 个待删文件全部跳过，避免删光所有副本`,
          check ? check.errorCode : null,
        )
        failures.push(item)
        const gr = groupState.get(g.groupId)
        gr.failures.push(item)
        gr.skipReason = 'KEEP_UNVERIFIED'
        gr.skipped = g.deleteCount
        gr.skippedPaths = g.deletes.map((d) => d.path)
        skippedFiles += g.deleteCount
        processed += g.deleteCount
      }
    }
  }

  /** 展开待处理任务；保留项失效的组不进入队列 */
  const tasks = []
  for (const g of plan.groups) {
    if (groupState.get(g.groupId).skipReason === 'KEEP_UNVERIFIED') continue
    g.deletes.forEach((d, indexInGroup) => tasks.push({ g, d, indexInGroup }))
  }

  /** 单个文件的只读复核：冲突 -> 全文件 SHA-256 -> 硬链接 -> 目录可写 */
  async function verifyOne(task) {
    const { g, d } = task
    const dKey = comparablePath(d.path)
    progress.currentPath = d.path
    if (dKey === comparablePath(g.keep.path)) {
      return failItem(d.path, g.groupId, g.size, 'CONFLICT', '该文件是本组保留项，拒绝删除', null)
    }
    if (allKeepKeys.has(dKey)) {
      return failItem(d.path, g.groupId, g.size, 'CONFLICT', '该文件被其他组指定为保留项，拒绝删除', null)
    }
    const keepCheck = keepChecks.get(g.groupId)
    if (!keepCheck || !keepCheck.ok) {
      return failItem(d.path, g.groupId, g.size, 'KEEP_UNVERIFIED', '保留项未通过复核，整组跳过', null)
    }
    const verified = await verifyFile(d.path, g.size, g.hash)
    if (!verified.ok) {
      return failItem(d.path, g.groupId, g.size, verified.reason, verified.message, verified.errorCode)
    }
    // 硬链接判定必须基于同一时刻的 lstat：阶段 1 的 keepCheck.stat 是删除前旧快照，
    // 保留项若被替换但沿用旧 inode / size / mtime，硬链接比对会失真（漏过真硬链接，
    // 或保留项内容已变却仍按旧快照继续删掉其余副本）。此处重读保留项，身份变化即跳过。
    let keepStat
    try {
      keepStat = await fsp.lstat(g.keep.path)
    } catch (err) {
      return failItem(d.path, g.groupId, g.size, 'KEEP_UNVERIFIED', '保留项未通过复核，整组跳过', err && err.code ? String(err.code) : null)
    }
    const prevKeepStat = keepCheck.stat
    if (
      keepStat.isSymbolicLink() || !keepStat.isFile() ||
      keepStat.dev !== prevKeepStat.dev || keepStat.ino !== prevKeepStat.ino ||
      keepStat.size !== prevKeepStat.size || keepStat.mtimeMs !== prevKeepStat.mtimeMs
    ) {
      return failItem(d.path, g.groupId, g.size, 'KEEP_UNVERIFIED', '保留项未通过复核，整组跳过', null)
    }
    if (
      verified.stat.dev === keepStat.dev &&
      verified.stat.ino === keepStat.ino &&
      verified.stat.ino !== 0
    ) {
      return failItem(d.path, g.groupId, g.size, 'HARD_LINK', '与保留项为同一硬链接，删除不会释放空间，已跳过', null)
    }
    try {
      await fsp.access(path.dirname(d.path), fs.constants.W_OK)
    } catch (err) {
      const c = classifyCleanError(err, 'access')
      return failItem(d.path, g.groupId, g.size, c.reason, `所在目录不可写：${c.message}`, c.errorCode)
    }
    return null
  }

  /**
   * 批量移除：优先用注入的 removeItemBatch（可一次并发调用系统回收站接口），
   * 否则把单个 removeItem 并发起来。最后统一做存在性确认，不逐文件轮询等待。
   * @returns {Promise<Map<string, Error|null>>} 失败路径 -> 错误对象
   */
  async function deleteBatch(paths) {
    const failed = new Map()
    if (typeof options.removeItemBatch === 'function') {
      const list = await options.removeItemBatch(paths)
      for (const f of Array.isArray(list) ? list : []) {
        if (f && typeof f.path === 'string') failed.set(f.path, f.error || null)
      }
    } else {
      await Promise.all(
        paths.map(async (p) => {
          try {
            await options.removeItem(p)
          } catch (err) {
            failed.set(p, err)
          }
        }),
      )
    }
    for (const p of paths) {
      if (failed.has(p)) continue
      if (fs.existsSync(p)) {
        const e = new Error('移除动作已执行但文件仍存在，未计入删除数')
        e.code = selection.mode === 'trash' ? 'TRASH_FAILED' : 'DELETE_FAILED'
        failed.set(p, e)
      }
    }
    return failed
  }

  /** 阶段 2：按批并发复核，随即批量删除该批全部通过项 */
  const batchSize = concurrency
  const batchCount = Math.ceil(tasks.length / batchSize)
  progress.batchCount = batchCount
  const stage = selection.mode === 'trash' ? 'trash' : 'unlink'

  for (let b = 0; b < batchCount; b += 1) {
    if (isCancelled()) {
      cancelled = true
      break
    }
    const batch = tasks.slice(b * batchSize, (b + 1) * batchSize)
    progress.batchIndex = b + 1
    progress.currentGroup = batch[0].g.groupId
    report('verifying', `批量复核 ${processed + 1}–${processed + batch.length} / ${totalFiles}（并发 ${concurrency}）`)

    // 批次一旦开始就完整执行（复核 + 删除）；中止只在批次边界生效，
    // 避免「已删除的文件因取消被算成跳过」的统计不一致。
    const checked = await Promise.all(
      batch.map(async (task) => {
        const item = await verifyOne(task)
        progress.verifiedFiles += 1
        report('verifying', `批量复核 ${progress.verifiedFiles} / ${totalFiles} · 第 ${b + 1}/${batchCount} 批`)
        return { task, item }
      }),
    )

    const ready = checked.filter((c) => !c.item)
    let removeErrors = new Map()
    if (ready.length > 0) {
      report('deleting', `批量删除 ${ready.length} 个 · 第 ${b + 1}/${batchCount} 批（并发 ${concurrency}）`)
      removeErrors = await deleteBatch(ready.map((c) => c.task.d.path))
    }

    const readySet = new Set(ready)
    for (const c of checked) {
      const { g, d } = c.task
      const gr = groupState.get(g.groupId)
      let item = c.item
      if (!item && readySet.has(c) && removeErrors.has(d.path)) {
        const err = removeErrors.get(d.path)
        const cl = err
          ? classifyCleanError(err, stage)
          : {
              reason: stage === 'trash' ? 'TRASH_FAILED' : 'DELETE_FAILED',
              message: '移除动作已执行但文件仍存在，未计入删除数',
              errorCode: null,
            }
        item = failItem(d.path, g.groupId, g.size, cl.reason, cl.message, cl.errorCode)
      }
      if (item) {
        failures.push(item)
        gr.failures.push(item)
        gr.skipped += 1
        gr.skippedPaths.push(d.path)
        skippedFiles += 1
      } else {
        deletedFiles += 1
        freedBytes += g.size
        gr.deleted += 1
        gr.freedBytes += g.size
        gr.deletedPaths.push(d.path)
      }
      processed += 1
      processedTasks += 1
    }

    progress.processedFiles = processed
    progress.deletedFiles = deletedFiles
    progress.freedBytes = freedBytes
    progress.failedFiles = failures.length
    report('deleting', `已处理 ${processed} / ${totalFiles} · 已删除 ${deletedFiles} · 失败 ${failures.length}`)
    await new Promise((resolve) => setImmediate(resolve))
  }

  if (cancelled) {
    // 中止时，批次循环尚未处理的任务此前只在汇总里被算作「跳过」，却没有记入所属组的
    // skipped / skippedPaths / failures，导致每组结果与 totals.skippedFiles 对不上、
    // 用户也看不到哪些文件被跳过。按与批次循环一致的方式逐条回填（仅影响中止路径）。
    const unprocessed = tasks.slice(processedTasks)
    const remaining = unprocessed.length
    for (const { g, d } of unprocessed) {
      const item = failItem(d.path, g.groupId, g.size, 'CANCELLED', '用户中止清理，该文件未处理', null)
      failures.push(item)
      const gr = groupState.get(g.groupId)
      gr.failures.push(item)
      gr.skipped += 1
      gr.skippedPaths.push(d.path)
      skippedFiles += 1
    }
    progress.failedFiles = failures.length
    errors.push({ code: 'CANCELLED', message: `用户中止清理，剩余 ${remaining} 个文件未处理`, phase: 'clean' })
  }

  const finishedAt = Date.now()
  const status = cancelled ? 'cancelled' : failures.length > 0 ? 'partial' : 'done'
  const spaceNote =
    selection.mode === 'trash'
      ? '文件已移入系统回收站：可从回收站恢复；磁盘空间需清空回收站后才会真正释放'
      : '文件已直接永久删除：磁盘空间已释放，操作不可恢复'
  const cleanResult = {
    cleanId,
    planId: plan.planId,
    scanId: result.scanId,
    mode: selection.mode,
    concurrency,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    status,
    scope: plan.scope,
    spaceNote,
    totals: {
      plannedGroups: plan.groups.length,
      plannedFiles: totalFiles,
      deletedFiles,
      freedBytes,
      skippedFiles,
      failedFiles: failures.length,
      keptFiles: plan.groups.length,
      verifiedFiles: progress.verifiedFiles,
      batches: batchCount,
    },
    groups: plan.groups.map((g) => groupState.get(g.groupId)),
    failures,
    errors,
  }
  report('done', `完成：删除 ${deletedFiles} 个，释放 ${freedBytes} 字节`)
  return cleanResult
}

module.exports = {
  canonicalSelection,
  buildCleanPlan,
  executeClean,
  verifyFile,
  classifyCleanError,
  makeScope,
  normalizeConcurrency,
  emptyProgress,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
}
