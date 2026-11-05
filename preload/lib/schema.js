'use strict'

/**
 * 配置项定义、结果字段定义、状态与错误码定义（含一键清理）。
 * 本文件是插件的「单一数据源」：preload 用它做权威校验，前端通过
 * window.services.getSchema() 读取它来渲染表单默认值和字段说明面板。
 */

const fs = require('node:fs')
const path = require('node:path')

/** 带业务错误码的异常，services.js 会转成 { ok:false, error } 返回给界面 */
class AppError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail === undefined ? null : detail
  }
}

/** 配置项定义（权威） */
const CONFIG_SCHEMA = [
  {
    key: 'roots',
    type: 'string[]',
    default: [],
    required: true,
    label: '扫描目录',
    description: '根目录绝对路径，至少一个；支持多目录，结果按绝对路径去重',
  },
  {
    key: 'recursive',
    type: 'boolean',
    default: true,
    label: '递归扫描',
    description: 'true 时遍历所有子目录；false 时只扫描根目录直属文件',
  },
  {
    key: 'includeDirs',
    type: 'string[]',
    default: [],
    label: '仅包含目录',
    description: '条目为目录名或绝对路径前缀；非空时，仅纳入位于匹配目录（或其子目录）内的文件',
  },
  {
    key: 'excludeDirs',
    type: 'string[]',
    default: ['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information'],
    label: '排除目录',
    description: '条目为目录名或绝对路径前缀；匹配到的目录整棵子树跳过，优先级高于「仅包含目录」',
  },
  {
    key: 'extensions',
    type: 'string[]',
    default: [],
    label: '文件类型',
    description: '允许的扩展名（不含点，大小写不敏感）；空数组表示不限制类型',
  },
  {
    key: 'minSize',
    type: 'number',
    default: 0,
    unit: 'byte',
    min: 0,
    label: '最小文件大小',
    description: '小于该字节数的文件跳过（含空文件）',
  },
  {
    key: 'maxSize',
    type: 'number|null',
    default: null,
    unit: 'byte',
    label: '最大文件大小',
    description: '大于该字节数的文件跳过；null 表示不设上限',
  },
  {
    key: 'excludeHidden',
    type: 'boolean',
    default: true,
    label: '排除隐藏项',
    description: '跳过名称以 . 开头的文件与目录',
  },
  {
    key: 'followSymlinks',
    type: 'boolean',
    default: false,
    label: '跟随符号链接',
    description: '默认关闭以避免链接成环；开启时用 realpath 去重；扫描阶段始终只读',
  },
  {
    key: 'maxFileCount',
    type: 'number',
    default: 20000,
    min: 1,
    max: 200000,
    label: '扫描文件数上限',
    description: '达到上限即停止枚举并标记 truncated，防止超大目录拖垮界面',
  },
  {
    key: 'hashAlgorithm',
    type: 'string',
    default: 'sha256',
    readonly: true,
    label: '内容哈希算法',
    description: '固定 SHA-256：同大小先做首尾采样哈希，再做全文件哈希，只有全文件哈希一致才判定重复',
  },
]

/** 结果字段定义（权威） */
const RESULT_SCHEMA = [
  { path: 'scanId', type: 'string', label: '扫描 ID', description: '本次扫描任务标识' },
  { path: 'startedAt / finishedAt / durationMs', type: 'number', label: '时间', description: '起止时间戳（毫秒）与耗时' },
  { path: 'status', type: 'enum', values: ['done', 'cancelled', 'truncated'], label: '扫描状态', description: 'done 正常完成；cancelled 用户取消（保留已完成的部分结果）；truncated 触及文件数上限' },
  { path: 'config', type: 'object', label: '实际配置', description: '已归一化并实际生效的配置快照' },
  { path: 'summary.scannedDirs / scannedFiles', type: 'number', label: '枚举计数', description: '遍历到的目录数 / 文件条目数' },
  { path: 'summary.skippedByFilter / skippedBySize', type: 'number', label: '过滤计数', description: '被目录、类型、隐藏规则过滤 / 被大小范围过滤的文件数' },
  { path: 'summary.matchedFiles / quickHashedFiles / hashedFiles', type: 'number', label: '候选计数', description: '通过全部过滤的非空文件数 / 完成首尾采样哈希数 / 完成全文件哈希数' },
  { path: 'summary.duplicateGroups / duplicateFiles / wastedBytes', type: 'number', label: '重复统计', description: '重复组数 / 组内文件总数 / 可释放字节数（sum(size × (count-1))）' },
  { path: 'summary.emptyFiles / noPermissionFiles / readFailedFiles / unreadableDirs', type: 'number', label: '异常计数', description: '四类明确状态的条目数量，明细见 issues' },
  { path: 'summary.truncated / cancelled', type: 'boolean', label: '中止标记', description: '是否触及上限 / 是否被用户取消' },
  { path: 'groups[].groupId', type: 'string', label: '组编号', description: 'G001 起，按可释放空间降序' },
  { path: 'groups[].hash', type: 'string', label: '内容哈希', description: '该组文件的完整 SHA-256 十六进制值' },
  { path: 'groups[].size', type: 'number', label: '单文件大小', description: '组内每个文件的字节数（必然相同）' },
  { path: 'groups[].count', type: 'number', label: '重复数量', description: '组内文件个数，>= 2' },
  { path: 'groups[].wastedBytes', type: 'number', label: '可释放空间', description: 'size × (count - 1)' },
  { path: 'groups[].files[]', type: 'object[]', label: '组内文件', description: 'path / size / mtimeMs / relativePath / rootIndex / status=OK' },
  { path: 'groups[].keepSuggestion', type: 'object', label: '建议保留项', description: '{ path, reason }；扫描阶段不执行任何文件操作，清理阶段作为每组默认保留项，用户可在预览中更换' },
  { path: 'issues[]', type: 'object[]', label: '状态明细', description: 'path / status / size / errorCode / message；覆盖空文件、无权限、读取失败、目录不可读' },
  { path: 'errors[]', type: 'object[]', label: '全局错误', description: 'code / message / phase；单项错误不中断整体扫描时记录于此' },
]

/**
 * 一键清理的输入定义（界面只传这些字段，不传文件路径清单）。
 * 删除清单始终由 preload 依据已完成的 ScanResult 生成，前端无法注入任意路径。
 */
const CLEAN_CONFIG_SCHEMA = [
  { key: 'scanId', type: 'string', required: true, label: '扫描 ID', description: '定位 preload 内保存的已完成扫描结果；结果不存在时必须重新扫描' },
  { key: 'groupIds', type: 'string[]', required: true, label: '待清理重复组', description: '从本次扫描结果的 groups[].groupId 中选择，至少一个；已清理过的组自动跳过' },
  { key: 'keepOverrides', type: 'object', default: {}, label: '保留项覆盖', description: '{ groupId: path }；每组保留一个文件，路径必须属于该组文件清单，否则拒绝执行' },
  { key: 'mode', type: 'enum', values: ['trash', 'permanent'], default: 'trash', label: '清理方式', description: 'trash 移入系统回收站（可恢复）；permanent 直接删除（不可恢复）' },
  { key: 'confirmToken', type: 'string', required: true, label: '确认令牌', description: '由 previewClean 签发，绑定具体清单；一次性、10 分钟有效，仅在执行阶段使用' },
  { key: 'confirmed', type: 'boolean', required: true, label: '风险确认', description: '必须为 true：界面已完成逐组核对 + 风险勾选（永久删除还需输入确认词）' },
  { key: 'excludedIndices', type: 'object', default: {}, label: '文件级批量排除', description: '{ groupId: number[] }，只传预览清单内的索引、绝不传路径；被排除的文件不复核不删除。令牌只绑定组 / 保留项 / 方式，取消勾选不会使确认失效' },
  { key: 'concurrency', type: 'number', default: 8, min: 1, max: 32, label: '批量并发数', description: '每批并发做全文件 SHA-256 复核、随后一次性批量删除的文件数；1~32，默认 8。越大越快，但占用更多文件句柄与磁盘 I/O' },
]

/** 清理方式定义 */
const CLEAN_MODE_DEFS = [
  {
    code: 'trash',
    label: '移到回收站（推荐，可恢复）',
    description: '通过 utools.shellTrashItem 移入系统回收站；删除后逐文件确认已从原路径移除。需清空回收站后才真正释放磁盘空间',
  },
  {
    code: 'permanent',
    label: '直接删除（不可恢复）',
    description: '通过 fs.unlink 永久删除并立即释放磁盘空间；不可撤销，界面需额外输入「直接删除」确认词',
  },
]

/** 清理失败 / 跳过原因定义，与 cleaner.js 的 failItem().reason 一一对应 */
const CLEAN_REASON_DEFS = [
  { code: 'NO_PERMISSION', label: '无权限', description: '文件不可读、所在目录不可写或系统返回 EACCES / EPERM，已跳过' },
  { code: 'FILE_IN_USE', label: '文件被占用', description: '打开或删除返回 EBUSY / ETXTBSY / 共享冲突，文件正在被其他程序使用，已跳过' },
  { code: 'MISSING', label: '文件已不存在', description: '扫描后文件被移除（ENOENT），已跳过' },
  { code: 'NOT_REGULAR_FILE', label: '非普通文件', description: '路径已变成目录或符号链接，拒绝删除' },
  { code: 'SIZE_CHANGED', label: '大小已变化', description: '删除前复核发现文件大小与扫描时不一致，拒绝删除' },
  { code: 'HASH_MISMATCH', label: '内容已变化', description: '删除前全文件 SHA-256 与该组哈希不一致，拒绝删除' },
  { code: 'CHANGED_DURING_VERIFY', label: '复核期间变化', description: '文件在复核读取期间被修改或截断，已跳过以免误删' },
  { code: 'HARD_LINK', label: '硬链接', description: '与保留项指向同一 inode，删除不会释放空间，已跳过' },
  { code: 'CONFLICT', label: '路径冲突', description: '该文件被另一组指定为保留项，已跳过' },
  { code: 'KEEP_UNVERIFIED', label: '保留项失效', description: '保留文件不存在或内容已变化，整组跳过以避免删光所有副本' },
  { code: 'TRASH_FAILED', label: '移入回收站失败', description: '调用回收站接口后文件仍存在（磁盘不支持回收站或文件被占用），未计入删除' },
  { code: 'DELETE_FAILED', label: '删除失败', description: '删除时返回其他系统错误，保留原始 errno' },
  { code: 'READ_FAILED', label: '复核读取失败', description: '删除前读取出现其他异常，保留原始 errno' },
  { code: 'CANCELLED', label: '用户中止', description: '清理被主动停止；当前批次执行完毕后停止，剩余文件未处理，已删除文件不会回滚' },
]

/** 清理结果字段定义（权威） */
const CLEAN_RESULT_SCHEMA = [
  { path: 'cleanId / planId / scanId', type: 'string', label: '任务标识', description: '清理任务 ID / 对应预览计划 ID / 来源扫描 ID' },
  { path: 'mode', type: 'enum', values: ['trash', 'permanent'], label: '清理方式', description: '实际执行的移除方式' },
  { path: 'concurrency', type: 'number', label: '批量并发数', description: '本次实际使用的每批并发数（1~32）' },
  { path: 'startedAt / finishedAt / durationMs', type: 'number', label: '时间', description: '起止时间戳（毫秒）与耗时' },
  { path: 'status', type: 'enum', values: ['done', 'partial', 'cancelled'], label: '清理状态', description: 'done 全部按计划完成；partial 存在跳过 / 失败项；cancelled 用户中止' },
  { path: 'scope', type: 'object', label: '清理范围', description: '来源扫描的配置快照（目录、递归、包含 / 排除、类型、大小范围等）' },
  { path: 'totals.plannedGroups / plannedFiles', type: 'number', label: '计划计数', description: '计划清理的组数 / 计划删除的文件数' },
  { path: 'totals.deletedFiles / freedBytes', type: 'number', label: '完成计数', description: '实际删除文件数 / 对应释放字节数（sum(各文件 size)）' },
  { path: 'totals.skippedFiles / failedFiles / keptFiles', type: 'number', label: '跳过与保留', description: '未删除文件数 / 失败明细条数 / 每组保留的文件数' },
  { path: 'totals.verifiedFiles / batches', type: 'number', label: '复核与批次', description: '完成删除前全文件 SHA-256 复核的文件数 / 总批次数' },
  { path: 'spaceNote', type: 'string', label: '空间说明', description: '回收站模式说明需清空回收站才真正释放空间；直接删除模式说明已释放' },
  { path: 'groups[]', type: 'object[]', label: '每组结果', description: 'groupId / hash / size / keepPath / planned / deleted / skipped / freedBytes / deletedPaths / skippedPaths / skipReason' },
  { path: 'failures[]', type: 'object[]', label: '失败项明细', description: 'path / groupId / size / reason / label / message / errorCode' },
  { path: 'errors[]', type: 'object[]', label: '全局错误', description: 'code / message / phase；例如用户中止' },
]

/** 批量清理的实时进度字段（界面进度区与字段说明面板同源） */
const CLEAN_PROGRESS_SCHEMA = [
  { path: 'phase', type: 'enum', values: ['init', 'verifying', 'deleting', 'done'], label: '阶段', description: 'init 准备 / verifying 批量复核全文件 SHA-256 / deleting 批量删除并确认 / done 完成' },
  { path: 'totalFiles / processedFiles / verifiedFiles', type: 'number', label: '进度计数', description: '计划删除总数 / 已处理结果数 / 已完成删除前全文件复核数' },
  { path: 'deletedFiles / freedBytes / failedFiles', type: 'number', label: '结果计数', description: '实际删除数 / 对应释放字节 / 失败明细条数' },
  { path: 'concurrency / batchIndex / batchCount', type: 'number', label: '批次', description: '每批并发数 / 当前批次 / 总批次数；复核通过后立即批量删除该批' },
  { path: 'currentGroup / currentPath / elapsedMs', type: 'string | number', label: '当前位置', description: '当前批次所属组 / 最近复核的文件 / 已耗时（毫秒）' },
]

/** issues[].status 取值定义 */
const STATUS_DEFS = [
  { code: 'EMPTY', label: '空文件', description: '大小为 0 字节；不参与内容哈希，单独列出，不并入重复组' },
  { code: 'NO_PERMISSION', label: '无读取权限', description: '打开或读取返回 EACCES / EPERM；未读取到内容，不判定重复' },
  { code: 'READ_FAILED', label: '读取失败', description: '其他读取异常（ENOENT 文件已移除、EIO、EBUSY 被占用等），保留 errno 与原始信息' },
  { code: 'DIR_UNREADABLE', label: '目录不可读', description: 'readdir 失败；跳过该目录，扫描继续' },
]

/** 错误码定义与处理策略 */
const ERROR_DEFS = [
  { code: 'INVALID_CONFIG', description: '配置字段类型或取值非法（如 minSize > maxSize、上限越界）', handling: '拒绝启动扫描，界面高亮对应配置项' },
  { code: 'NO_ROOTS', description: '未指定任何扫描目录', handling: '提示先添加目录' },
  { code: 'ROOT_NOT_FOUND', description: '根目录不存在', handling: '提示检查路径，其余目录仍可继续扫描' },
  { code: 'ROOT_NOT_DIRECTORY', description: '根路径不是目录', handling: '跳过该根路径并记录到 errors[]' },
  { code: 'MAX_FILE_COUNT_EXCEEDED', description: '达到 maxFileCount', handling: '停止枚举，结果标记 truncated，已完成部分照常输出' },
  { code: 'SCAN_CRASH', description: '扫描过程出现未预期异常', handling: '任务置为 error，界面展示原始错误信息，不产生任何写操作' },
  { code: 'CANCELLED', description: '用户主动取消', handling: '停止读取，保留已完成的部分结果并标记 cancelled' },
  { code: 'JOB_NOT_FOUND', description: '任务 ID 不存在或已被清理', handling: '界面重置为未扫描状态' },
  { code: 'INVALID_TARGET', description: '导出目标路径非法（非绝对路径、父目录不存在等）', handling: '拒绝写入' },
  { code: 'TARGET_EXISTS', description: '导出目标文件已存在', handling: '拒绝覆盖，请另选文件名' },
  { code: 'EXPORT_FAILED', description: '报告写入失败', handling: '返回原始 errno，不重试、不改动任何被扫描文件' },
  { code: 'SCAN_RESULT_NOT_FOUND', description: '找不到对应 scanId 的扫描结果（已过期或重新打开插件）', handling: '拒绝生成预览与清理，提示重新扫描' },
  { code: 'NO_GROUPS_SELECTED', description: '未选择任何待清理的重复组', handling: '拒绝生成预览，界面提示先勾选' },
  { code: 'INVALID_SELECTION', description: '组 ID 不存在、保留项不在组内、组数据不完整、缺少有效 SHA-256，或文件级排除索引越界 / 非整数', handling: '拒绝生成预览与清理，界面展示具体组 ID' },
  { code: 'INVALID_CLEAN_MODE', description: '清理方式不是 trash / permanent', handling: '拒绝执行，界面重新选择清理方式' },
  { code: 'ALREADY_CLEANED', description: '所选重复组在本次扫描中已清理过', handling: '自动跳过这些组；全部已清理时提示重新扫描' },
  { code: 'INVALID_CONFIRM', description: '确认令牌缺失、已使用、清单与预览不一致或未完成风险确认', handling: '拒绝执行，界面重新生成预览并二次确认' },
  { code: 'CONFIRM_EXPIRED', description: '确认令牌超过 10 分钟有效期', handling: '拒绝执行，界面重新生成预览' },
  { code: 'TRASH_UNAVAILABLE', description: '当前 uTools 环境不提供 shellTrashItem 接口', handling: '拒绝回收站模式，可改用直接删除；不自动降级为永久删除' },
  { code: 'CLEAN_CRASH', description: '清理过程出现未预期异常', handling: '任务置为 error，界面展示原始信息，已完成的文件不再回滚' },
  { code: 'CLEAN_JOB_NOT_FOUND', description: '清理任务 ID 不存在或已清理', handling: '界面重置清理进度状态' },
  { code: 'CLEAN_JOB_RUNNING', description: '清理任务仍在运行中', handling: '界面继续轮询进度' },
]

const DEFAULT_EXCLUDE_DIRS = CONFIG_SCHEMA.find((f) => f.key === 'excludeDirs').default.slice()

const IS_WINDOWS_PATH = path.sep === '\\'

/** 统一比较用路径：Windows 大小写不敏感，其余平台保持大小写 */
function comparablePath(p) {
  const normalized = path.normalize(path.resolve(p)).replace(/[\\/]+$/, '')
  return IS_WINDOWS_PATH ? normalized.toLowerCase() : normalized
}

/** 目录规则条目归一化：绝对路径保留，否则作为目录名；支持已归一化的 { raw } 对象（保证幂等） */
function normalizeDirRule(entry) {
  const source = entry && typeof entry === 'object' && typeof entry.raw === 'string' ? entry.raw : entry
  const raw = String(source).trim().replace(/[\\/]+$/, '')
  if (!raw) return null
  if (path.isAbsolute(raw)) {
    return { kind: 'absolute', value: comparablePath(raw), raw }
  }
  return { kind: 'name', value: IS_WINDOWS_PATH ? raw.toLowerCase() : raw, raw }
}

function toStringArray(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new AppError('INVALID_CONFIG', '应为字符串数组')
  return value
    .map((v) => (v && typeof v === 'object' && typeof v.raw === 'string' ? v.raw.trim() : String(v).trim()))
    .filter(Boolean)
}

function toNumber(value, field) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new AppError('INVALID_CONFIG', `${field} 必须是有效数字`)
  }
  return n
}

/**
 * 校验并归一化配置。所有来自界面的输入都必须经过此处，preload 不信任前端。
 * @returns {object} 归一化后的配置快照
 */
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('INVALID_CONFIG', '配置必须是对象')
  }

  const rootsRaw = toStringArray(raw.roots)
  const roots = []
  const seenRoots = new Set()
  for (const r of rootsRaw) {
    const abs = path.resolve(r)
    const key = comparablePath(abs)
    if (!seenRoots.has(key)) {
      seenRoots.add(key)
      roots.push(abs)
    }
  }
  if (roots.length === 0) throw new AppError('NO_ROOTS', '请至少指定一个扫描目录')

  const minSize = toNumber(raw.minSize === undefined ? 0 : raw.minSize, 'minSize')
  if (minSize < 0 || !Number.isInteger(minSize)) {
    throw new AppError('INVALID_CONFIG', 'minSize 必须是 >= 0 的整数（字节）')
  }
  const maxSizeRaw = raw.maxSize === undefined || raw.maxSize === null || raw.maxSize === '' ? null : toNumber(raw.maxSize, 'maxSize')
  const maxSize = maxSizeRaw === null ? null : Math.trunc(maxSizeRaw)
  if (maxSize !== null && (!Number.isInteger(maxSize) || maxSize < 0)) {
    throw new AppError('INVALID_CONFIG', 'maxSize 必须是 >= 0 的整数或 null')
  }
  if (maxSize !== null && maxSize < minSize) {
    throw new AppError('INVALID_CONFIG', 'maxSize 不能小于 minSize')
  }

  const maxFileCount = Math.trunc(toNumber(raw.maxFileCount === undefined ? 20000 : raw.maxFileCount, 'maxFileCount'))
  if (maxFileCount < 1 || maxFileCount > 200000) {
    throw new AppError('INVALID_CONFIG', 'maxFileCount 必须在 1 ~ 200000 之间')
  }

  const extensions = toStringArray(raw.extensions).map((e) => e.replace(/^\./, '').toLowerCase())
  const includeDirs = toStringArray(raw.includeDirs).map(normalizeDirRule).filter(Boolean)
  const excludeDirs = toStringArray(raw.excludeDirs).map(normalizeDirRule).filter(Boolean)

  return {
    configVersion: 1,
    roots,
    recursive: raw.recursive === undefined ? true : Boolean(raw.recursive),
    includeDirs,
    excludeDirs,
    extensions,
    minSize,
    maxSize,
    excludeHidden: raw.excludeHidden === undefined ? true : Boolean(raw.excludeHidden),
    followSymlinks: raw.followSymlinks === undefined ? false : Boolean(raw.followSymlinks),
    maxFileCount,
    hashAlgorithm: 'sha256',
  }
}

/** 检查根目录可用性；不可用的根记录为全局错误，而不是让整个扫描失败 */
function inspectRoots(cfg) {
  const valid = []
  const errors = []
  for (const root of cfg.roots) {
    try {
      const stat = fs.statSync(root)
      if (!stat.isDirectory()) {
        errors.push({ code: 'ROOT_NOT_DIRECTORY', message: `根路径不是目录：${root}`, phase: 'validate-root' })
        continue
      }
      valid.push({ root, key: comparablePath(root) })
    } catch (err) {
      errors.push({
        code: 'ROOT_NOT_FOUND',
        message: `根目录不可访问：${root}`,
        phase: 'validate-root',
        detail: err && err.code ? err.code : null,
      })
    }
  }
  return { valid, errors }
}

/** 供导出报告与界面展示的精简 schema（不含内部函数） */
function publicSchema() {
  return {
    config: CONFIG_SCHEMA,
    result: RESULT_SCHEMA,
    statuses: STATUS_DEFS,
    errors: ERROR_DEFS,
    cleanConfig: CLEAN_CONFIG_SCHEMA,
    cleanResult: CLEAN_RESULT_SCHEMA,
    cleanProgress: CLEAN_PROGRESS_SCHEMA,
    cleanReasons: CLEAN_REASON_DEFS,
    cleanModes: CLEAN_MODE_DEFS,
  }
}

module.exports = {
  AppError,
  CONFIG_SCHEMA,
  RESULT_SCHEMA,
  STATUS_DEFS,
  ERROR_DEFS,
  CLEAN_CONFIG_SCHEMA,
  CLEAN_RESULT_SCHEMA,
  CLEAN_PROGRESS_SCHEMA,
  CLEAN_REASON_DEFS,
  CLEAN_MODE_DEFS,
  DEFAULT_EXCLUDE_DIRS,
  comparablePath,
  normalizeDirRule,
  normalizeConfig,
  inspectRoots,
  publicSchema,
}
