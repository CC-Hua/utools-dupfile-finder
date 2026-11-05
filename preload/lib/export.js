'use strict'

/**
 * 报告导出：只创建「新文件」，绝不覆盖。
 * 使用 flag 'wx' 原子创建；目标已存在时拒绝覆盖，绝不修改或删除被扫描文件。
 * 除此之外，插件唯一的删除动作在 cleaner.js，且必须经用户二次确认。
 */

const fs = require('node:fs')
const path = require('node:path')
const { AppError } = require('./schema.js')

function exportReport(targetPath, content) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    throw new AppError('INVALID_TARGET', '导出路径不能为空')
  }
  const raw = targetPath.trim()
  if (!path.isAbsolute(raw)) {
    throw new AppError('INVALID_TARGET', '导出路径必须是绝对路径')
  }
  if (typeof content !== 'string') {
    throw new AppError('INVALID_TARGET', '报告内容必须是字符串')
  }
  const abs = path.normalize(raw)
  const parent = path.dirname(abs)
  try {
    if (!fs.statSync(parent).isDirectory()) {
      throw new AppError('INVALID_TARGET', `导出目标的上级目录不存在：${parent}`)
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError('INVALID_TARGET', `导出目标的上级目录不可访问：${parent}`, err.code || null)
  }
  if (fs.existsSync(abs)) {
    throw new AppError('TARGET_EXISTS', `目标文件已存在，为避免覆盖请另选文件名：${abs}`)
  }
  try {
    fs.writeFileSync(abs, content, { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new AppError('TARGET_EXISTS', `目标文件已存在，为避免覆盖请另选文件名：${abs}`)
    }
    throw new AppError('EXPORT_FAILED', `报告写入失败：${err && err.message ? err.message : String(err)}`, err && err.code ? err.code : null)
  }
  return { path: abs, bytes: Buffer.byteLength(content, 'utf8') }
}

module.exports = { exportReport }
