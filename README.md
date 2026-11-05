# 文件查重 · 功能介绍

uTools 插件。按**文件内容**识别指定目录下的重复文件，先给只读报告，再由用户显式发起可选的一键清理。

> 一句话定位：**扫描只读，清理独立且必须二次确认，每组始终保留一个文件。**

---

## 1 · 能做什么

| 能力 | 说明 |
|---|---|
| 递归扫描 | 支持多个根目录、`包含 / 排除` 目录规则、文件类型、大小范围、隐藏项、符号链接开关 |
| 内容判重 | 不用文件名、不靠修改时间；按大小分桶 → 首尾采样 SHA-256 → **全文件 SHA-256**，只有全文件哈希一致才判定重复 |
| 只读报告 | 按重复组展示路径、大小、重复数量、可释放空间、建议保留项；空文件 / 无权限 / 读取失败 / 目录不可读单列状态 |
| 一键清理 | 逐组预览「保留 / 将删除」清单 → **文件级批量勾选** → 风险提示与二次确认 → 一次操作**批量复核 + 批量删除**所有已勾选项，每组保留 1 个 |
| 批量提速 | 可设每批并发数（1~32，默认 8）；批内并发做全文件 SHA-256 复核，通过后立即整批删除；进度按「批量复核 / 批量删除 / 批次」实时反馈 |
| 报告导出 | 扫描结果与清理结果均可导出 **HTML（浏览器直接打开）/ TXT（记事本直接打开）**，无需转换或专业工具；字段与数据口径不变、全量不截断，只新建文件、目标已存在即拒绝覆盖 |
| 进度与中止 | 扫描、清理均为异步任务，界面实时显示阶段、批次、已复核 / 已处理 / 已删除 / 释放 / 失败与耗时；可随时取消，当前批次完成后停止 |

---

## 2 · 安装与启动

1. 用 uTools 开发者工具导入发布包 `dupfile-finder-v1.0.0.zip`，或直接指向成果目录 `E:\Temp Files\utool-插件\utools-dupfile-finder` 内的 `plugin.json`。
2. 搜索任一指令：`文件查重`、`重复文件`、`查找重复文件`、`清理重复文件`、`删除重复文件`。
3. 也可把**文件夹拖入 uTools**，触发 `扫描此文件夹查重` 直接填入目录（1~10 个）。

**成果目录**：`E:\Temp Files\utool-插件\utools-dupfile-finder`（`plugin.json` 在根，另有 `README.md` 即本文档）。发布包 `dupfile-finder-v1.0.0.zip` 与 `文件查重-1.0.0.upxs` 放在其上级 `E:\Temp Files\utool-插件\`，与其他插件发布包平级，避免被 uTools 二次打包。

> 页面已改为**单文件 `index.html`**（JS / CSS 全部内联，零外部资源）。uTools 以 `file://` 加载插件，旧版含 `assets/` + `type="module" crossorigin` 的产物会被 Chromium 的 CORS 策略拦截，表现为整页空白。若你导入的是 2026-11-05 下午之前的包，请用新 zip 重新导入。

开发期：`npm run dev`，用 `public/plugin.json` 接入热更新；`npm run build` **直接产出到成果目录**，无需手动同步；`npm run smoke` 用无头浏览器真跑一次页面，防止「构建通过但白屏」。

---

## 3 · 界面流程（8 个分区）

| # | 分区 | 作用 |
|---|---|---|
| 1 | 扫描目录 | 添加 / 移除根目录，或拖入文件夹自动填充 |
| 2 | 扫描配置 | **默认收起**：点击标题行或右侧「▸ 展开配置」按钮展开；展开后完整显示递归、包含 / 排除、类型、大小范围、隐藏项、符号链接、文件数上限，再次点击「▾ 收起配置」收起。收起状态不影响已填配置，直接点「开始扫描」仍按当前配置执行 |
| 3 | 执行与导出 | 开始 / 取消扫描、进度条、导出扫描报告 HTML / TXT |
| 4 | 扫描摘要 | 枚举数、过滤数、哈希数、重复组 / 文件数、可释放空间、异常计数 |
| 5 | 重复组 | 折叠分组列表，按可释放空间降序，含建议保留项与理由 |
| 6 | 一键清理重复文件 | 范围快照 → 勾选组 / 更换保留项 → 选方式与**批量并发数** → 冻结预览 → **文件级全选 / 反选 / 全不选** → 风险确认 → 批量复核与删除 |
| 7 | 清理结果 | 已删除数、释放空间、跳过 / 失败数、**完成复核数 / 批次 / 并发**、每组结果与失败原因、导出清理报告 HTML / TXT |
| 8 | 状态明细 | 按 `EMPTY / NO_PERMISSION / READ_FAILED / DIR_UNREADABLE` 分类查看明细 |

顶部「字段说明」面板与 preload 校验逻辑**同源**，配置项、结果字段、状态码、错误码均实时取自 `schema.js`。

### 3.1 · 报告导出（双击即可阅读）

分区 3 与分区 7 各保留两个导出按钮，位置、启用条件、保存对话框、「只新建不覆盖」与提示流程均不变，仅把文件格式换成无需额外转换或专业工具的版本：

| 格式 | 打开方式 | 特点 |
|---|---|---|
| `HTML` | 任意浏览器双击打开（离线可用，可直接打印） | 单文件、零外部脚本 / 样式 / 图片；标题 → 关键指标卡片 → 目录导航 → 分组明细 → 附录，层次清晰、重点高亮 |
| `TXT` | Windows 记事本双击打开 | UTF-8 BOM + CRLF，中文不乱码；用分隔线、缩进、对齐表格呈现同样的层级 |

两种格式由 `src/report.js` 的**同一份文档模型**渲染，内容与插件内报告完全一致：

- **字段不减**：报告信息、全部汇总字段、生效配置 / 清理范围、全量重复组与每个文件的 `path / size / mtimeMs / relativePath / rootIndex / status / 建议保留`、状态明细、失败 / 跳过项、全局错误全部在列。
- **口径不变**：可读数值复用 `format.js`，与界面卡片同源；**附录 A** 按旧版 CSV 的列名与行结构 1:1 输出全部明细行（`section / groupId / hash / size / count / wastedBytes / path / fileSize / mtimeMs / isKeep / status / errorCode / message` 等）；**附录 B** 内嵌 `JSON.stringify(data, null, 2)` 完整原始数据，任何嵌套字段都不丢。
- **不截断**：界面上的「加载更多 / 再显示 N 个」只影响屏幕显示，导出始终是全部组、全部文件、全部状态项。
- **安全**：所有数据写入前做 HTML 转义，报告内不含脚本与外部资源；导出仍由 preload 用 `flag:'wx'` 原子新建，目标已存在即拒绝覆盖。

---

## 4 · 扫描配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `roots` | string[] | `[]` | 根目录绝对路径，至少一个，支持多目录并按绝对路径去重 |
| `recursive` | boolean | `true` | `false` 时只扫描根目录直属文件 |
| `includeDirs` | string[] | `[]` | 目录名或绝对路径前缀；非空时仅纳入匹配目录（及其子目录）内文件 |
| `excludeDirs` | string[] | `node_modules`、`.git`、`$RECYCLE.BIN`、`System Volume Information` | 整棵子树跳过，**优先级高于包含规则** |
| `extensions` | string[] | `[]` | 允许的扩展名（不含点，大小写不敏感）；空 = 全部类型 |
| `minSize` / `maxSize` | number / number\|null | `0` / `null` | 字节范围；超范围跳过，`null` 表示不设上限 |
| `excludeHidden` | boolean | `true` | 跳过名称以 `.` 开头的文件与目录 |
| `followSymlinks` | boolean | `false` | 默认关闭避免成环；开启时用 realpath 去重 |
| `maxFileCount` | number | `20000` | 1~200000；触顶停止枚举并标记 `truncated` |
| `hashAlgorithm` | string | `sha256` | 固定，只读，不可更改 |

过滤顺序：目录 / 隐藏 / 类型 → 大小范围 → 空文件状态。单项读取失败只记入 `issues[]`，不中断整体扫描。

---

## 5 · 扫描结果字段

| 字段 | 说明 |
|---|---|
| `scanId` / `startedAt` / `finishedAt` / `durationMs` / `status` | 任务标识、时间戳、耗时；`done` / `cancelled` / `truncated` |
| `config` / `errors[]` | 实际生效配置快照 / 全局错误（`code` `message` `phase`） |
| `summary.*` | 枚举、过滤、采样哈希 / 全量哈希、重复组 / 文件 / 可释放字节、四类异常计数、中止标记 |
| `groups[].groupId / hash / size / count / wastedBytes` | 组编号（按可释放空间降序）、完整 SHA-256、单份大小、重复数量、`size × (count-1)` |
| `groups[].files[]` | `path` `size` `mtimeMs` `relativePath` `rootIndex` `status=OK` |
| `groups[].keepSuggestion` | `{ path, reason }`；优先级：层级最浅 → 文件名无复制标记 → mtime 最早 → 路径序 |
| `issues[]` | `path` `status` `size` `errorCode` `message` |

**明确状态**：`EMPTY`（0 字节，单列不分组）、`NO_PERMISSION`（EACCES/EPERM）、`READ_FAILED`（ENOENT/EBUSY/EIO/内容截断等，保留 errno）、`DIR_UNREADABLE`（readdir 失败，跳过该目录不中断）。

---

## 6 · 一键清理（重点）

### 操作流程

1. **确认范围**：第 6 面板展示本次清理来源的扫描范围快照（根目录、递归、包含 / 排除、类型、大小范围、隐藏项、判重依据、`scanId`）。要改范围请返回重新扫描。
2. **选择组**：勾选要清理的重复组（全选 / 全不选），可为每组更换保留文件。
3. **选方式与并发**：默认「移到回收站」；可选「直接删除」。设置每批并发数（1~32，默认 8），界面显示预计批次数。
4. **生成预览**（不执行任何操作）：得到冻结快照——组数、每组保留 / 将删除的**完整路径**、将删除数量、预计释放空间。
5. **批量选择待复核文件**：预览里每个待删文件都有勾选框，可「全选 / 全不选 / 反选」；卡片数字与预计释放空间实时跟随。未勾选的文件不复核、不删除；**取消勾选只会少删，不会使确认令牌失效**，无需重新生成预览或重新确认。
6. **二次确认**：阅读风险提示，勾选两项确认；永久删除还需输入「直接删除」四个字。一次确认覆盖整批，不对每个文件重复确认。
7. **批量复核与删除**：一次点击按批并发执行「全文件 SHA-256 复核 → 立即整批删除 → 统一存在性确认」，每组保留 1 个；进度区显示阶段、批次、已复核 / 已处理 / 已删除 / 释放 / 失败 / 耗时；第 7 面板给出每组结果与逐条失败原因。

### 只删重复文件的安全约束

- 界面**不能提交文件路径清单**，只能提交 `groupIds / keepOverrides / mode / excludedIndices / concurrency`；`excludedIndices` 是**预览清单内的索引**（不传路径），由 preload 映射到扫描结果中的路径；删除清单始终由 preload 内存中保存的 `ScanResult` 重建。
- `previewClean` 签发**一次性确认令牌**，绑定 `groupIds / keepOverrides / mode`（`selectionKey`），10 分钟有效、用完即失效；清单与预览不一致、未勾选确认、令牌复用一律拒绝。排除索引只可能少删，不进入 `selectionKey`，但仍由服务端校验合法性（非负整数、不得越界）。
- 每组**先验证保留文件**仍存在且内容一致（并发、每组一次），否则整组跳过，杜绝删光所有副本。
- 每个待删文件删除前复用扫描引擎的 `fullHash` **再做一次全文件 SHA-256 复核**，大小、类型、内容任一不符即跳过。并发化**没有减少任何一次复核**，只是让复核与删除紧邻、批量并行。
- 只删普通文件：符号链接、目录、与保留项同一 inode 的硬链接、被其他组指定为保留项的路径一律跳过。
- 单项失败不中断整体，全部记入 `failures[]`；已清理过的组自动跳过。中止只在**批次边界**生效，当前批次执行完毕后停止，已删除文件不会被误记为跳过、也不会回滚。

### 批量处理为什么更快

| 优化 | 原实现 | 现实现 |
|---|---|---|
| 文件处理 | 逐文件串行：哈希 → 目录可写 → 删除 → 存在性确认 | 每批 N 个并发复核，随后整批一次删除、统一确认 |
| 回收站等待 | 不 await `shellTrashItem` 返回的 Promise，逐文件轮询最多 1.2 秒 | 整批并发 await 官方 Promise，只对仍存在的文件做**一次**整批等待 |
| 进度刷新 | 每 8 个文件更新一次，前端 150ms 轮询 | 每批复核 / 删除均上报，前端 80ms 轮询，批次与阶段可见 |
| 重复确认 | 改动任何选择都要重新生成预览并重新勾选 | 文件级取消勾选、调整并发数都不影响令牌，一次确认覆盖整批 |

### 两种清理方式

| 方式 | 实现 | 特点 |
|---|---|---|
| `trash`（默认，推荐） | `utools.shellTrashItem`（整批并发 await） | 移入系统回收站，**可恢复**；整批统一确认已离开原路径。需清空回收站才真正释放磁盘空间，结果里明确标注，不虚报释放量 |
| `permanent` | `fs.unlink` | 立即释放空间，**不可恢复**；界面需额外输入确认词 |

回收站接口不可用时**直接拒绝**，绝不自动降级为永久删除。

### 跳过 / 失败原因（14 类）

`NO_PERMISSION` 无权限 · `FILE_IN_USE` 被占用 · `MISSING` 文件已不存在 · `NOT_REGULAR_FILE` 非普通文件 · `SIZE_CHANGED` 大小已变化 · `HASH_MISMATCH` 内容已变化 · `CHANGED_DURING_VERIFY` 复核期间变化 · `HARD_LINK` 硬链接 · `CONFLICT` 路径冲突 · `KEEP_UNVERIFIED` 保留项失效（整组跳过） · `TRASH_FAILED` 移入回收站失败 · `DELETE_FAILED` 删除失败 · `READ_FAILED` 复核读取失败 · `CANCELLED` 用户中止。

---

## 7 · 错误处理

全局错误码含 `INVALID_CONFIG`、`NO_ROOTS`、`ROOT_NOT_FOUND`、`ROOT_NOT_DIRECTORY`、`MAX_FILE_COUNT_EXCEEDED`、`SCAN_CRASH`、`CANCELLED`、`SCAN_RESULT_NOT_FOUND`、`NO_GROUPS_SELECTED`、`INVALID_SELECTION`、`INVALID_CONFIRM`、`CONFIRM_EXPIRED`、`TRASH_UNAVAILABLE`、`ALREADY_CLEANED`、`TARGET_EXISTS` 等共 22 项。界面统一展示 `[code] message`；单项失败只记录不中断任务。清理异常不会回滚已删除文件。

---

## 8 · 只读边界与写操作清单

| 阶段 | 文件操作 |
|---|---|
| 扫描 | 仅 `stat` / `readdir` / `open('r')` / `read` / `realpath`，**无任何写入、移动、重命名、删除** |
| 导出报告 | 用户主动触发，`flag:'wx'` 原子新建 HTML / TXT 报告，目标已存在即拒绝覆盖；不改动任何被扫描文件 |
| 配置持久化 | `utools.dbStorage` 仅在点击「开始扫描」时写一次，规避 300ms 写入间隔约束 |
| 清理 | 唯一会移除被扫描文件的路径，且必须满足第 6 节全部确认条件 |

---

## 9 · 技术实现

| 层 | 文件 | 职责 |
|---|---|---|
| 界面 | `src/App.vue` + `src/style.css` | Vue 3 单页，8 个分区 + 字段说明；主题自适应 |
| 报告渲染 | `src/report.js` | 同一份文档模型渲染自包含 HTML / 纯文本 TXT；保留旧版 CSV 明细表与完整原始 JSON |
| 构建 | `vite.config.js` | `base:'./'`；`build.outDir` 直接指向成果目录；`emptyOutDir:false` 保护 README 等非产物文件；**构建后把 JS / CSS 内联进 `index.html` 并清空 `assets/`**（`file://` 零外部请求）；内联脚本在 Node `vm` 中做语法自检；移除 `development` 字段、校验 `plugin.json` |
| 定义 | `public/preload/lib/schema.js` | 配置 / 结果 / 状态 / 错误码**单一数据源** + 幂等归一化校验 |
| 扫描 | `public/preload/lib/scanner.js` | 枚举、过滤、两阶段哈希、分组、建议保留、取消与进度 |
| 清理 | `public/preload/lib/cleaner.js` | 冻结计划 + 文件级排除索引、并发批次「全 SHA-256 复核 → 批量删除 → 统一确认」、跳过策略与统计；移除器由外部注入便于审计 |
| 导出 | `public/preload/lib/export.js` | 只新建报告文件（`flag:'wx'`） |
| 桥接 | `public/preload/services.js` | 最小权限暴露、扫描 / 清理双任务状态机、一次性确认令牌、批量回收站移除器与并发数注入 |

命令：首次构建或清理依赖后先 `npm install` → `npm run dev` / `npm run build` / `npm test` / `npm run smoke`。

- `npm run build` 直接写入成果目录，不再生成 `dist/`；换路径可用环境变量 `UTOOLS_OUT_DIR` 覆盖，例如 `UTOOLS_OUT_DIR="D:/plugins/dup" npm run build`。
- 构建不会清空成果目录，但会覆盖 `plugin.json` / `index.html` / `logo.png` / `preload/`；**`index.html` 是自包含单文件，构建后 `assets/` 目录会被清空并移除**，`README.md` 等其余文件原样保留。
- 内联必须用**函数式 `String.replace` 回调**：字符串替换参数里的 `$&` 会被展开成被匹配的文本，直接拼接会把内联 JS 污染成 `</body>`，导致脚本被截断、页面白屏。构建插件已用 `vm.Script` 做语法自检兜底。
- `npm test` 只用 Node 内置模块，未安装依赖也能运行；`npm run smoke` 需要本机 Edge / Chrome（可用 `SMOKE_BROWSER` 指定），找不到浏览器时自动跳过。

**验证状态**：`npm run build` 通过，产物直接落在成果目录，`plugin.json` 无 `development`，`README.md` 完好，工作区未再生成 `dist/`；`npm test` **42/42 通过**（扫描 11 + 清理 19 + 导出报告 12）；`npm run smoke` **PASS**——用无头 Edge 以 `file://` 真跑页面，`#app` 渲染出 header / section、可见文本 529 字、**0 错误 0 警告**，且确认产物无 `type="module"` / `crossorigin` / `./assets/`。清理用例覆盖「首尾采样相同但中间不同不得误判」「只删重复项且每组保留一个」「内容变化 / 保留项失效 / 硬链接 / EBUSY 跳过」「确认令牌一次性与清单绑定」，以及批量版新增的「并发批次统计一致」「批量移除器失败项」「文件级排除索引越界与令牌不受影响」「并发下防护不降级」「中止在批次边界生效且统计守恒」「进度阶段与批次字段」「preload 批量链路」。

**导出报告验证（2026-11-05）**：`tests/report.test.cjs` 的 12 组断言覆盖 HTML 自包含 / 无脚本注入、TXT UTF-8 BOM + CRLF、扫描与清理报告全字段、35 组 127 个文件全量不截断、附录 A 旧版 CSV 列名与行数、附录 B 原始 JSON 逐字一致、指标与 `format.js` 同口径、空结果成文、文件名 / 过滤器、以及 `flag:'wx'` 只新建且拒绝覆盖。另用无头 Edge 以 `file://` 直接打开真实导出的 HTML 报告：标题 / 指标卡片 / 目录 / 分组明细表 / 附录全部可见，0 控制台错误；TXT 首 3 字节为 `EF BB BF`，2438 行 CRLF 文本。

**白屏问题已定位并修复（2026-11-05）**，共两处独立原因：① `file://` 下 Vite 的 `type="module" crossorigin` 脚本与样式被 CORS 拦截 → 改为构建期内联单文件；② `emptyCleanProgress()` 在 setup 顶层读取了尚未声明的 `cleanConcurrency`（TDZ），导致 App 组件创建失败 → 调整声明顺序。此前所有构建只做静态字符串校验、从未真正执行页面，故两类问题都漏到了实机；现已加入 `npm run smoke` 作为构建后的渲染回归。

> 页面渲染已在 `file://` 无头浏览器中验证，**仍未在 uTools 客户端跑完整功能流程**。实机请重点确认 `utools.shellTrashItem` 在当前 uTools 版本可用；若不可用，回收站模式会被拒绝，需显式改选「直接删除」（不可恢复）。`dupfile-finder-v1.0.0.zip` 已随本次改动重新打包；若使用 `.upxs` 发布包，请在 uTools 中基于最新成果目录重新打包。

---

## 10 · 已知限制

- 判重基于完整 SHA-256，不做模糊 / 相似度匹配（不同压缩率、不同编码的同一张图片不视为重复）。
- 文件数上限默认 20000，触顶即停止枚举，结果不完整并标记 `truncated`。
- 扫描结果保存在 preload 内存中，插件重启或重新打开后需重新扫描才能清理。
- 硬链接会被跳过（删除不释放空间）；符号链接默认不跟随，且始终不作为删除对象。
- 回收站模式下 `freedBytes` 只表示「已从原路径移走的文件大小」，实际磁盘空间需清空回收站后才释放。
- 清理不提供撤销 / 回滚，回收站模式可通过系统回收站手动恢复。
- 并发数越高越快，但会同时打开更多文件句柄、占用更多磁盘 I/O；机械硬盘或网络盘建议用 4~8，遇到 I/O 竞争可降到 1（退化为逐文件串行，安全约束不变）。
- 回收站批量调用依赖 `utools.shellTrashItem` 返回 Promise 的官方签名；旧版 uTools 若返回 `undefined`，代码兼容但会退化为「整批一次短等待 + 统一确认」，仍需实机确认。
