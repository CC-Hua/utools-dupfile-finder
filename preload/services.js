'use strict'

/**
 * preload 桥接层：向界面暴露最小必要能力。
 * 不暴露 fs / path / crypto 等高权限对象；所有方法返回 { ok, ... } 结构，
 * 避免异常跨隔离上下文丢失错误信息。
 *
 * 扫描与清理都采用「启动 + 轮询」模型：preload 内异步执行并维护任务状态，
 * 界面定时读取进度，不需要把回调函数跨上下文传递，也不会阻塞界面。
 *
 * 权限边界：
 *  - 扫描结果保存在 preload 内存中（界面只拿到一份展示副本），清理清单由服务端重建；
 *  - 清理必须经过 previewClean 签发的一次性确认令牌，且清单与预览完全一致；
 *  - 界面无法提交任意文件路径，只能提交组 ID / 保留项覆盖 / 清理方式。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')

const { AppError, normalizeConfig, publicSchema } = require('./lib/schema.js')
const { scan } = require('./lib/scanner.js')
const { exportReport } = require('./lib/export.js')
const {
  canonicalSelection,
  buildCleanPlan,
  executeClean,
  normalizeConcurrency,
  emptyProgress,
} = require('./lib/cleaner.js')

const jobs = new Map() // 扫描任务 jobId -> job
const cleanJobs = new Map() // 清理任务 jobId -> job
const results = new Map() // scanId -> 权威 ScanResult
const cleanedGroups = new Map() // scanId -> Set(groupId)
const confirmations = new Map() // confirmToken -> 一次性确认记录
const MAX_JOBS = 5
const MAX_CONFIRMATIONS = 20
const CONFIRM_TTL_MS = 10 * 60 * 1000
let jobSeq = 0

function ok(extra) {
  return Object.assign({ ok: true }, extra)
}

function toError(err, fallbackCode) {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, detail: err.detail }
  }
  return {
    code: fallbackCode || 'SCAN_CRASH',
    message: err && err.message ? String(err.message) : String(err),
    detail: err && err.code ? String(err.code) : null,
  }
}

function fail(err, fallbackCode) {
  return { ok: false, error: toError(err, fallbackCode) }
}

/** 按插入顺序裁剪内存表，避免长时间使用累积过多结果 */
function trimMap(map, max) {
  while (map.size > max) {
    const oldestKey = map.keys().next().value
    map.delete(oldestKey)
  }
}

function trimJobs() {
  while (jobs.size > MAX_JOBS) {
    const oldestId = jobs.keys().next().value
    const oldest = jobs.get(oldestId)
    if (oldest && oldest.status === 'running') oldest.cancelled = true
    jobs.delete(oldestId)
  }
}

/**
 * 移除器工厂：清理引擎不接触 uTools API，移除动作在此注入。
 *
 * shellTrashItem(fullPath) 返回 Promise<void>（旧版可能返回 undefined，两者都兼容）。
 * 旧实现逐文件调用后各自轮询最多 1.2 秒，是批量清理的主要等待来源；
 * 现在整批并发 await，只对「仍存在」的路径做一次整批等待。
 * 回收站接口不可用时直接拒绝，绝不悄悄降级为永久删除。
 *
 * removeItemBatch 契约：Promise<Array<{ path, error? }>>，只返回失败项。
 */
function getUtools() {
  if (typeof utools !== 'undefined' && utools) return utools
  if (typeof window !== 'undefined' && window.utools) return window.utools
  return null
}

function createRemovers(mode) {
  if (mode === 'permanent') {
    const removeItem = async (filePath) => {
      await fsp.unlink(filePath)
    }
    return {
      removeItem,
      removeItemBatch: async (paths) => {
        const out = await Promise.all(
          paths.map(async (p) => {
            try {
              await fsp.unlink(p)
              return null
            } catch (err) {
              return { path: p, error: err }
            }
          }),
        )
        return out.filter(Boolean)
      },
    }
  }

  const u = getUtools()
  if (!u || typeof u.shellTrashItem !== 'function') {
    throw new AppError('TRASH_UNAVAILABLE', '当前 uTools 环境不提供回收站接口，请改用「直接删除」或升级 uTools')
  }
  const trashOne = async (filePath) => {
    const ret = u.shellTrashItem(filePath)
    if (ret && typeof ret.then === 'function') await ret
  }
  return {
    removeItem: trashOne,
    removeItemBatch: async (paths) => {
      const failures = []
      await Promise.all(
        paths.map(async (p) => {
          try {
            await trashOne(p)
          } catch (err) {
            failures.push({ path: p, error: err })
          }
        }),
      )
      const failedKeys = new Set(failures.map((f) => f.path))
      // 整批只等一次：把 N 次 50ms 轮询压缩成 1 次
      let left = paths.filter((p) => !failedKeys.has(p) && fs.existsSync(p))
      for (let i = 0; i < 24 && left.length > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        left = left.filter((p) => fs.existsSync(p))
      }
      for (const p of left) failures.push({ path: p, error: null })
      return failures
    },
  }
}

// ---------------- 扫描 ----------------

/** 启动扫描；配置先做同步校验，非法配置立即返回错误，不创建任务 */
function startScan(rawConfig) {
  try {
    normalizeConfig(rawConfig)
    const jobId = `job-${Date.now()}-${++jobSeq}`
    const job = {
      id: jobId,
      status: 'running',
      cancelled: false,
      startedAt: Date.now(),
      progress: { phase: 'init', scannedDirs: 0, scannedFiles: 0, matchedFiles: 0, totalCandidates: 0, processedCandidates: 0, message: '准备扫描…' },
      result: null,
      error: null,
    }
    jobs.set(jobId, job)
    trimJobs()

    scan(rawConfig, {
      isCancelled: () => job.cancelled,
      onProgress: (p) => {
        job.progress = p
      },
    })
      .then((result) => {
        job.result = result
        job.status = 'done'
        results.set(result.scanId, result)
        cleanedGroups.set(result.scanId, new Set())
        trimMap(results, MAX_JOBS)
        trimMap(cleanedGroups, MAX_JOBS)
      })
      .catch((err) => {
        job.error = toError(err, 'SCAN_CRASH')
        job.status = 'error'
      })
    return ok({ jobId })
  } catch (err) {
    return fail(err, 'SCAN_CRASH')
  }
}

/** 查询扫描进度；界面以 ~150ms 间隔轮询 */
function getProgress(jobId) {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: { code: 'JOB_NOT_FOUND', message: '扫描任务不存在或已清理', detail: null } }
  return ok({ status: job.status, progress: job.progress, error: job.error })
}

/** 获取完整扫描结果；任务运行中或失败时返回结构化错误 */
function getResult(jobId) {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: { code: 'JOB_NOT_FOUND', message: '扫描任务不存在或已清理', detail: null } }
  if (job.status === 'running') return { ok: false, error: { code: 'JOB_RUNNING', message: '扫描仍在进行中', detail: null } }
  if (job.status === 'error') return { ok: false, error: job.error }
  if (!job.result) return { ok: false, error: { code: 'JOB_NOT_FOUND', message: '扫描结果不可用', detail: null } }
  return ok({ result: job.result })
}

/** 请求取消扫描：当前读取完成后即停止，保留已完成的部分结果 */
function cancelScan(jobId) {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: { code: 'JOB_NOT_FOUND', message: '扫描任务不存在或已清理', detail: null } }
  if (job.status === 'running') job.cancelled = true
  return ok({ cancelled: job.cancelled })
}

// ---------------- 一键清理 ----------------

function getScanResult(scanId) {
  const result = results.get(scanId)
  if (!result) {
    throw new AppError('SCAN_RESULT_NOT_FOUND', '找不到本次扫描结果（可能已过期或插件已重载），请重新扫描')
  }
  return result
}

/** 查询某次扫描中已清理过的组，供界面禁用重复清理 */
function getCleanState(scanId) {
  const set = cleanedGroups.get(scanId)
  return ok({ cleanedGroupIds: set ? Array.from(set) : [] })
}

/**
 * 生成清理预览：纯只读，不改动任何文件。
 * 同时签发一次性确认令牌，令牌绑定 scanId 与具体清单（selectionKey）。
 */
function previewClean(scanId, rawSelection) {
  try {
    const result = getScanResult(scanId)
    const selection = canonicalSelection(rawSelection)
    const cleaned = cleanedGroups.get(scanId) || new Set()
    const plan = buildCleanPlan(result, selection, cleaned)
    const token = `cf-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`
    confirmations.set(token, { scanId, selectionKey: selection.key, createdAt: Date.now(), used: false })
    trimMap(confirmations, MAX_CONFIRMATIONS)
    return ok({
      plan,
      confirmToken: token,
      expiresAt: Date.now() + CONFIRM_TTL_MS,
      cleanedGroupIds: Array.from(cleaned),
    })
  } catch (err) {
    return fail(err, 'CLEAN_CRASH')
  }
}

/**
 * 执行清理。必须同时满足：确认令牌有效且未使用、清单与预览一致、
 * 界面已完成风险确认、组未清理过。校验通过后令牌立即置为已用，杜绝双击重复执行。
 */
function startClean(payload) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AppError('INVALID_CONFIRM', '缺少确认信息，拒绝执行清理')
    }
    if (payload.confirmed !== true) {
      throw new AppError('INVALID_CONFIRM', '未完成风险确认，拒绝执行清理')
    }
    const rec = confirmations.get(payload.confirmToken)
    if (!rec) throw new AppError('INVALID_CONFIRM', '确认信息无效，请重新生成清理预览')
    if (rec.used) throw new AppError('INVALID_CONFIRM', '该确认已使用，如需继续请重新生成清理预览')
    if (Date.now() - rec.createdAt > CONFIRM_TTL_MS) {
      throw new AppError('CONFIRM_EXPIRED', '确认已超过 10 分钟有效期，请重新生成清理预览')
    }

    // selectionKey 只绑定 groupIds / keepOverrides / mode。excludedIndices 是
    // 「从已确认清单里少删几项」，由 buildCleanPlan 用索引映射到计划内路径，
    // 不会引入任何新路径，因此不影响令牌校验，用户取消勾选无需重新确认。
    const selection = canonicalSelection(payload.selection)
    if (selection.key !== rec.selectionKey) {
      throw new AppError('INVALID_CONFIRM', '清理清单与预览时不一致，请重新核对并生成预览')
    }
    if (payload.scanId !== rec.scanId) {
      throw new AppError('INVALID_CONFIRM', '扫描结果不匹配，请重新扫描')
    }
    const concurrency = normalizeConcurrency(payload.concurrency)
    const result = getScanResult(payload.scanId)
    const cleaned = cleanedGroups.get(payload.scanId) || new Set()
    const plan = buildCleanPlan(result, selection, cleaned) // 服务端再次校验：排除已清理组 + 校验排除索引
    const removers = createRemovers(selection.mode) // trash 不可用时直接拒绝，不降级

    rec.used = true
    const jobId = `clean-job-${Date.now()}-${++jobSeq}`
    const job = {
      id: jobId,
      status: 'running',
      cancelled: false,
      startedAt: Date.now(),
      scanId: payload.scanId,
      progress: emptyProgress(plan.totals.deleteCount, concurrency),
      result: null,
      error: null,
    }
    cleanJobs.set(jobId, job)
    trimMap(cleanJobs, MAX_JOBS)

    executeClean(result, selection, {
      removeItem: removers.removeItem,
      removeItemBatch: removers.removeItemBatch,
      concurrency,
      cleanedIds: cleaned,
      isCancelled: () => job.cancelled,
      onProgress: (p) => {
        job.progress = p
      },
    })
      .then((cleanResult) => {
        job.result = cleanResult
        job.status = 'done'
        const set = cleanedGroups.get(payload.scanId) || new Set()
        cleanResult.groups.forEach((g) => set.add(g.groupId))
        cleanedGroups.set(payload.scanId, set)
      })
      .catch((err) => {
        job.error = toError(err, 'CLEAN_CRASH')
        job.status = 'error'
      })
    return ok({
      jobId,
      plannedFiles: plan.totals.deleteCount,
      concurrency,
      batches: Math.ceil(plan.totals.deleteCount / concurrency),
    })
  } catch (err) {
    return fail(err, 'CLEAN_CRASH')
  }
}

function getCleanProgress(jobId) {
  const job = cleanJobs.get(jobId)
  if (!job) return { ok: false, error: { code: 'CLEAN_JOB_NOT_FOUND', message: '清理任务不存在或已清理', detail: null } }
  return ok({ status: job.status, progress: job.progress, error: job.error })
}

function getCleanResult(jobId) {
  const job = cleanJobs.get(jobId)
  if (!job) return { ok: false, error: { code: 'CLEAN_JOB_NOT_FOUND', message: '清理任务不存在或已清理', detail: null } }
  if (job.status === 'running') return { ok: false, error: { code: 'CLEAN_JOB_RUNNING', message: '清理仍在进行中', detail: null } }
  if (job.status === 'error') return { ok: false, error: job.error }
  if (!job.result) return { ok: false, error: { code: 'CLEAN_JOB_NOT_FOUND', message: '清理结果不可用', detail: null } }
  return ok({ result: job.result })
}

/** 中止清理：当前文件处理完成后停止，已完成的文件不会回滚 */
function cancelClean(jobId) {
  const job = cleanJobs.get(jobId)
  if (!job) return { ok: false, error: { code: 'CLEAN_JOB_NOT_FOUND', message: '清理任务不存在或已清理', detail: null } }
  if (job.status === 'running') job.cancelled = true
  return ok({ cancelled: job.cancelled })
}

// ---------------- 通用 ----------------

/** 配置项 / 结果字段 / 状态 / 错误码 / 清理定义（供界面渲染字段说明） */
function getSchema() {
  return ok({ schema: publicSchema() })
}

/** 导出报告：只写新文件，目标已存在时拒绝 */
function exportFileReport(targetPath, content) {
  try {
    return ok(exportReport(targetPath, content))
  } catch (err) {
    return fail(err, 'EXPORT_FAILED')
  }
}

window.services = {
  getSchema,
  startScan,
  getProgress,
  getResult,
  cancelScan,
  previewClean,
  getCleanState,
  startClean,
  getCleanProgress,
  getCleanResult,
  cancelClean,
  exportReport: exportFileReport,
}
