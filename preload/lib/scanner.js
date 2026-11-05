'use strict'

/**
 * 只读文件查重引擎。
 *
 * 判定流程：目录枚举 -> 规则过滤 -> 按大小分桶 -> 首尾采样 SHA-256 -> 全文件 SHA-256
 *          -> 按 (size, fullHash) 分组 -> 生成建议保留项。
 *
 * 只读保证：本模块全程只使用 stat / readdir / open(只读) / read / realpath，
 * 不调用任何写入、重命名、删除、回收站 API。
 * 删除能力独立在 cleaner.js 中，必须经用户二次确认才会被调用；fullHash 被
 * cleaner.js 复用，用于删除前的内容复验，保证扫描与清理使用同一判定口径。
 */

const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const {
  AppError,
  comparablePath,
  normalizeConfig,
  inspectRoots,
} = require('./schema.js')

const SAMPLE_BYTES = 64 * 1024
const READ_CHUNK_BYTES = 64 * 1024
const YIELD_EVERY_FILES = 32
const YIELD_EVERY_DIRS = 8
const COPY_MARKER = /(\(|\（)\s*\d+\s*(\)|\）)|(副本|复件|拷贝|复制|\bcopy\b|[-_\s]copy\d*)$/i

/** 让出事件循环，避免长时间扫描阻塞插件界面 */
function yieldTick() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 读取异常 -> 明确状态。
 * EACCES / EPERM 视为无读取权限；其余（含文件被删除、被占用、内容变化）视为读取失败。
 */
function classifyReadError(err) {
  const rawCode = err && err.code ? String(err.code) : (err && err.message ? String(err.message) : 'UNKNOWN')
  const message = err && err.message ? String(err.message) : '未知读取错误'
  const permissionCodes = ['EACCES', 'EPERM']
  const hints = {
    ENOENT: '文件在扫描期间被移除',
    EBUSY: '文件被其他程序占用',
    EIO: '设备或磁盘读取错误',
    UNEXPECTED_EOF: '文件内容在扫描期间被截断',
    SCAN_RACE: '文件在读取期间发生变化，已跳过判定以避免误判',
    ELOOP: '符号链接层级过多',
    ENAMETOOLONG: '路径过长',
  }
  return {
    status: permissionCodes.includes(rawCode) ? 'NO_PERMISSION' : 'READ_FAILED',
    errorCode: rawCode,
    message: hints[rawCode] ? `${hints[rawCode]}（${message}）` : message,
  }
}

function sameName(a, b) {
  return path.sep === '\\' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b
}

/** 绝对路径规则：full === rule 或 full 位于 rule 之下 */
function pathEqualOrUnder(full, ruleValue) {
  const c = comparablePath(full)
  return c === ruleValue || c.startsWith(ruleValue + path.sep)
}

function matchesDirRule(full, name, rules) {
  for (const rule of rules) {
    if (rule.kind === 'name' && sameName(name, rule.value)) return true
    if (rule.kind === 'absolute' && pathEqualOrUnder(full, rule.value)) return true
  }
  return false
}

/** 仅包含规则：文件所在目录链中任一目录匹配即纳入 */
function matchesInclude(fullDir, chain, rules) {
  if (rules.length === 0) return true
  for (const rule of rules) {
    if (rule.kind === 'name' && chain.some((c) => sameName(c.name, rule.value))) return true
    if (rule.kind === 'absolute' && pathEqualOrUnder(fullDir, rule.value)) return true
  }
  return false
}

/** 从已打开的文件句柄读取 [position, position+length) 并喂给 hash */
async function feedHash(handle, hash, position, length, strictLength) {
  const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(length, 1)))
  let pos = position
  let remaining = length
  while (remaining > 0) {
    const want = Math.min(buf.length, remaining)
    const { bytesRead } = await handle.read(buf, 0, want, pos)
    if (bytesRead <= 0) {
      if (strictLength) {
        const e = new Error('UNEXPECTED_EOF')
        e.code = 'UNEXPECTED_EOF'
        throw e
      }
      break
    }
    hash.update(buf.subarray(0, bytesRead))
    pos += bytesRead
    remaining -= bytesRead
  }
}

/** 首尾采样哈希：小文件直接整读，大文件读头部 + 尾部各 SAMPLE_BYTES */
async function sampleHash(filePath, size) {
  const hash = crypto.createHash('sha256')
  hash.update(`size:${size};`)
  const handle = await fsp.open(filePath, 'r')
  try {
    if (size <= SAMPLE_BYTES * 2) {
      await feedHash(handle, hash, 0, size, true)
    } else {
      await feedHash(handle, hash, 0, SAMPLE_BYTES, true)
      await feedHash(handle, hash, size - SAMPLE_BYTES, SAMPLE_BYTES, true)
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** 全文件 SHA-256；读取前后校验 size/mtime，避免把扫描期间被改动的文件误判为重复 */
async function fullHash(filePath, expectedSize) {
  const hash = crypto.createHash('sha256')
  const handle = await fsp.open(filePath, 'r')
  try {
    const before = await handle.stat()
    await feedHash(handle, hash, 0, before.size, true)
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      const e = new Error('SCAN_RACE')
      e.code = 'SCAN_RACE'
      throw e
    }
    if (before.size !== expectedSize) {
      const e = new Error('SCAN_RACE')
      e.code = 'SCAN_RACE'
      throw e
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

function emptySummary() {
  return {
    scannedDirs: 0,
    scannedFiles: 0,
    skippedByFilter: 0,
    skippedBySize: 0,
    matchedFiles: 0,
    quickHashedFiles: 0,
    hashedFiles: 0,
    duplicateGroups: 0,
    duplicateFiles: 0,
    wastedBytes: 0,
    emptyFiles: 0,
    noPermissionFiles: 0,
    readFailedFiles: 0,
    unreadableDirs: 0,
    truncated: false,
    cancelled: false,
  }
}

function emptyProgress() {
  return {
    phase: 'init',
    scannedDirs: 0,
    scannedFiles: 0,
    matchedFiles: 0,
    totalCandidates: 0,
    processedCandidates: 0,
    message: '准备扫描…',
  }
}

/**
 * 生成建议保留项。扫描阶段仅为参考，不执行任何文件操作；
 * 清理阶段作为每组默认保留项，用户可在预览中更换。
 * 优先级：路径层级最浅 -> 文件名无复制标记 -> 修改时间最早 -> 路径字典序最小。
 */
function pickKeepSuggestion(files) {
  const scored = files.map((f) => ({
    file: f,
    depth: f.relativePath.split(path.sep).length - 1,
    isCopy: COPY_MARKER.test(path.basename(f.path, path.extname(f.path))),
    mtimeMs: f.mtimeMs,
  }))
  scored.sort(
    (a, b) =>
      a.depth - b.depth ||
      Number(a.isCopy) - Number(b.isCopy) ||
      a.mtimeMs - b.mtimeMs ||
      a.file.path.localeCompare(b.file.path, 'zh-CN'),
  )
  const win = scored[0]
  const reasons = ['路径层级最浅（离扫描根目录最近）']
  if (scored.filter((s) => s.depth === win.depth).length > 1) reasons.push('文件名不含副本 / 复制标记')
  if (scored.filter((s) => s.depth === win.depth && s.isCopy === win.isCopy).length > 1) reasons.push('修改时间最早')
  if (scored.filter((s) => s.depth === win.depth && s.isCopy === win.isCopy && s.mtimeMs === win.mtimeMs).length > 1) {
    reasons.push('路径字典序最小')
  }
  return { path: win.file.path, reason: reasons.join('；') }
}

/**
 * 执行一次完整扫描。
 * @param {object} rawConfig 未信任的界面配置（内部会做权威校验）
 * @param {{ isCancelled?: Function, onProgress?: Function }} hooks
 * @returns {Promise<object>} ScanResult（字段定义见 schema.js 的 RESULT_SCHEMA）
 */
async function scan(rawConfig, hooks = {}) {
  const cfg = normalizeConfig(rawConfig)
  const isCancelled = typeof hooks.isCancelled === 'function' ? hooks.isCancelled : () => false
  const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {}

  const startedAt = Date.now()
  const scanId = `scan-${startedAt}-${crypto.randomBytes(3).toString('hex')}`
  const result = {
    scanId,
    startedAt,
    finishedAt: null,
    durationMs: 0,
    status: 'done',
    config: cfg,
    summary: emptySummary(),
    groups: [],
    issues: [],
    errors: [],
  }
  const progress = emptyProgress()
  const report = (phase, message) => {
    progress.phase = phase
    progress.message = message
    progress.scannedDirs = result.summary.scannedDirs
    progress.scannedFiles = result.summary.scannedFiles
    progress.matchedFiles = result.summary.matchedFiles
    onProgress(Object.assign({}, progress))
  }

  const { valid: validRoots, errors: rootErrors } = inspectRoots(cfg)
  result.errors.push(...rootErrors)
  if (validRoots.length === 0) {
    const first = rootErrors[0] || { code: 'ROOT_NOT_FOUND', message: '没有可用的扫描目录' }
    throw new AppError(first.code, first.message, rootErrors)
  }

  const matched = []
  const seenFiles = new Set()
  const visitedDirs = new Set(validRoots.map((r) => r.key))
  let truncated = false
  let cancelled = false

  const addIssue = (item) => {
    result.issues.push(item)
    if (item.status === 'EMPTY') result.summary.emptyFiles += 1
    else if (item.status === 'NO_PERMISSION') result.summary.noPermissionFiles += 1
    else if (item.status === 'READ_FAILED') result.summary.readFailedFiles += 1
    else if (item.status === 'DIR_UNREADABLE') result.summary.unreadableDirs += 1
  }

  /** 收集单个文件：过滤顺序 = 目录/类型/隐藏 -> 大小范围 -> 空文件状态 */
  const collectFile = async (filePath, rootIndex, root, chain, fullDir) => {
    result.summary.scannedFiles += 1
    if (result.summary.scannedFiles > cfg.maxFileCount) {
      truncated = true
      return
    }
    const key = comparablePath(filePath)
    if (seenFiles.has(key)) {
      result.summary.skippedByFilter += 1
      return
    }
    const name = path.basename(filePath)
    if (cfg.excludeHidden && name.startsWith('.')) {
      result.summary.skippedByFilter += 1
      return
    }
    if (!matchesInclude(fullDir, chain, cfg.includeDirs)) {
      result.summary.skippedByFilter += 1
      return
    }
    if (matchesDirRule(fullDir, path.basename(fullDir), cfg.excludeDirs)) {
      result.summary.skippedByFilter += 1
      return
    }
    const ext = path.extname(name).replace(/^\./, '').toLowerCase()
    if (cfg.extensions.length > 0 && !cfg.extensions.includes(ext)) {
      result.summary.skippedByFilter += 1
      return
    }

    let stat
    try {
      stat = await fsp.lstat(filePath)
    } catch (err) {
      const c = classifyReadError(err)
      addIssue({ path: filePath, size: null, status: c.status, errorCode: c.errorCode, message: c.message, rootIndex, relativePath: path.relative(root, filePath) })
      return
    }
    if (!stat.isFile()) {
      result.summary.skippedByFilter += 1
      return
    }
    const size = stat.size
    if (size < cfg.minSize || (cfg.maxSize !== null && size > cfg.maxSize)) {
      result.summary.skippedBySize += 1
      return
    }
    const relativePath = path.relative(root, filePath) || name
    if (size === 0) {
      addIssue({
        path: filePath,
        size: 0,
        status: 'EMPTY',
        errorCode: null,
        message: '空文件（0 字节）：不参与内容哈希，单独列出',
        rootIndex,
        relativePath,
      })
      return
    }
    seenFiles.add(key)
    result.summary.matchedFiles += 1
    matched.push({ path: filePath, size, mtimeMs: stat.mtimeMs, rootIndex, relativePath, root })
  }

  // ---------- 阶段 1：枚举 ----------
  report('enumerating', '正在递归枚举文件…')
  const queue = validRoots.map((r, i) => ({ dir: r.root, rootIndex: i, root: r.root, chain: [], depth: 0 }))
  let dirCounter = 0
  outer: while (queue.length > 0) {
    if (isCancelled()) {
      cancelled = true
      break
    }
    const current = queue.shift()
    let entries
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true })
    } catch (err) {
      const c = classifyReadError(err)
      addIssue({
        path: current.dir,
        size: null,
        status: 'DIR_UNREADABLE',
        errorCode: c.errorCode,
        message: `目录无法读取，已跳过：${c.message}`,
        rootIndex: current.rootIndex,
        relativePath: path.relative(current.root, current.dir),
      })
      continue
    }
    result.summary.scannedDirs += 1
    dirCounter += 1
    if (dirCounter % YIELD_EVERY_DIRS === 0) await yieldTick()

    for (const entry of entries) {
      if (isCancelled()) {
        cancelled = true
        break outer
      }
      if (truncated) break outer
      if (cfg.excludeHidden && entry.name.startsWith('.')) continue

      const full = path.join(current.dir, entry.name)
      const chain = current.chain.concat([{ full, name: entry.name }])

      if (entry.isDirectory()) {
        if (!cfg.recursive) continue
        if (matchesDirRule(full, entry.name, cfg.excludeDirs)) continue
        queue.push({ dir: full, rootIndex: current.rootIndex, root: current.root, chain, depth: current.depth + 1 })
        continue
      }

      if (entry.isSymbolicLink()) {
        if (!cfg.followSymlinks) {
          result.summary.skippedByFilter += 1
          continue
        }
        try {
          const real = await fsp.realpath(full)
          const realKey = comparablePath(real)
          const stat = await fsp.stat(real)
          if (stat.isDirectory()) {
            if (!cfg.recursive || visitedDirs.has(realKey)) continue
            if (matchesDirRule(real, path.basename(real), cfg.excludeDirs)) continue
            visitedDirs.add(realKey)
            queue.push({ dir: real, rootIndex: current.rootIndex, root: current.root, chain, depth: current.depth + 1 })
          } else if (stat.isFile()) {
            await collectFile(real, current.rootIndex, current.root, chain, path.dirname(real))
          }
        } catch (err) {
          const c = classifyReadError(err)
          addIssue({ path: full, size: null, status: c.status, errorCode: c.errorCode, message: `符号链接解析失败：${c.message}`, rootIndex: current.rootIndex, relativePath: path.relative(current.root, full) })
        }
        continue
      }

      if (entry.isFile()) {
        await collectFile(full, current.rootIndex, current.root, chain, current.dir)
        if (result.summary.scannedFiles % YIELD_EVERY_FILES === 0) await yieldTick()
      }
    }
    report('enumerating', `已枚举 ${result.summary.scannedDirs} 个目录 / ${result.summary.scannedFiles} 个文件`)
  }

  // ---------- 阶段 2：按大小分桶 + 首尾采样哈希 ----------
  const bySize = new Map()
  for (const f of matched) {
    if (!bySize.has(f.size)) bySize.set(f.size, [])
    bySize.get(f.size).push(f)
  }
  const quickCandidates = []
  for (const bucket of bySize.values()) {
    if (bucket.length >= 2) quickCandidates.push(...bucket)
  }
  progress.totalCandidates = quickCandidates.length
  progress.processedCandidates = 0
  report('quickHash', '正在做首尾采样哈希，缩小候选范围…')

  let processed = 0
  for (const f of quickCandidates) {
    if (isCancelled()) {
      cancelled = true
      break
    }
    try {
      f.quickHash = await sampleHash(f.path, f.size)
      result.summary.quickHashedFiles += 1
    } catch (err) {
      const c = classifyReadError(err)
      addIssue({ path: f.path, size: f.size, status: c.status, errorCode: c.errorCode, message: c.message, rootIndex: f.rootIndex, relativePath: f.relativePath })
      f.quickHash = null
    }
    processed += 1
    progress.processedCandidates = processed
    if (processed % YIELD_EVERY_FILES === 0) {
      report('quickHash', `采样哈希 ${processed} / ${quickCandidates.length}`)
      await yieldTick()
    }
  }

  const byQuick = new Map()
  for (const f of quickCandidates) {
    if (!f.quickHash) continue
    const key = `${f.size}:${f.quickHash}`
    if (!byQuick.has(key)) byQuick.set(key, [])
    byQuick.get(key).push(f)
  }
  const fullCandidates = []
  for (const bucket of byQuick.values()) {
    if (bucket.length >= 2) fullCandidates.push(...bucket)
  }

  // ---------- 阶段 3：全文件哈希（最终判重依据） ----------
  progress.totalCandidates = fullCandidates.length
  progress.processedCandidates = 0
  report('fullHash', '正在计算全文件 SHA-256…')
  processed = 0
  for (const f of fullCandidates) {
    if (isCancelled()) {
      cancelled = true
      break
    }
    try {
      f.hash = await fullHash(f.path, f.size)
      result.summary.hashedFiles += 1
    } catch (err) {
      const c = classifyReadError(err)
      addIssue({ path: f.path, size: f.size, status: c.status, errorCode: c.errorCode, message: c.message, rootIndex: f.rootIndex, relativePath: f.relativePath })
      f.hash = null
    }
    processed += 1
    progress.processedCandidates = processed
    if (processed % YIELD_EVERY_FILES === 0) {
      report('fullHash', `全文件哈希 ${processed} / ${fullCandidates.length}`)
      await yieldTick()
    }
  }

  // ---------- 阶段 4：按 (size, sha256) 分组 ----------
  report('grouping', '正在生成重复组与建议保留项…')
  const byHash = new Map()
  for (const f of fullCandidates) {
    if (!f.hash) continue
    const key = `${f.size}:${f.hash}`
    if (!byHash.has(key)) byHash.set(key, [])
    byHash.get(key).push(f)
  }

  const groups = []
  for (const [key, bucket] of byHash.entries()) {
    if (bucket.length < 2) continue
    const size = bucket[0].size
    const hash = bucket[0].hash
    const files = bucket
      .map((f) => ({
        path: f.path,
        size: f.size,
        mtimeMs: f.mtimeMs,
        relativePath: f.relativePath,
        rootIndex: f.rootIndex,
        status: 'OK',
      }))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
    groups.push({
      groupId: '',
      key,
      hash,
      size,
      count: files.length,
      wastedBytes: size * (files.length - 1),
      files,
      keepSuggestion: pickKeepSuggestion(files),
    })
  }
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || b.count - a.count || a.files[0].path.localeCompare(b.files[0].path, 'zh-CN'))
  groups.forEach((g, i) => {
    g.groupId = `G${String(i + 1).padStart(3, '0')}`
    delete g.key
  })
  result.groups = groups
  result.summary.duplicateGroups = groups.length
  result.summary.duplicateFiles = groups.reduce((n, g) => n + g.count, 0)
  result.summary.wastedBytes = groups.reduce((n, g) => n + g.wastedBytes, 0)
  result.summary.truncated = truncated
  result.summary.cancelled = cancelled
  result.status = cancelled ? 'cancelled' : truncated ? 'truncated' : 'done'

  if (truncated) {
    result.errors.push({
      code: 'MAX_FILE_COUNT_EXCEEDED',
      message: `已达扫描文件数上限 ${cfg.maxFileCount}，结果为部分数据`,
      phase: 'enumerating',
    })
  }
  if (cancelled) {
    result.errors.push({ code: 'CANCELLED', message: '用户取消扫描，结果仅包含已完成哈希的部分', phase: 'scan' })
  }

  result.finishedAt = Date.now()
  result.durationMs = result.finishedAt - startedAt
  report('done', `完成：${groups.length} 组重复文件`)
  return result
}

module.exports = { scan, classifyReadError, pickKeepSuggestion, fullHash }
