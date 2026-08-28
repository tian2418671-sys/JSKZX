/**
 * 预加载脚本：通过 contextBridge 安全地把主进程能力暴露给渲染进程
 * 渲染进程只能通过 window.electronAPI 访问这些受控方法，无法直接触碰 Node.js
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // 触发选择文件夹（返回扫描结果）
    selectFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    // 加载上次的配置（返回扫描结果）
    loadConfig: () => ipcRenderer.invoke('config:load'),
    // 重新扫描当前角色卡库目录（刷新按钮用，无需重新弹目录选择框）
    rescanLibrary: (folderPath) => ipcRenderer.invoke('library:rescan', folderPath),
    // 📁 物理文件夹分组：在库目录下新建分组文件夹
    createGroupFolder: (data) => ipcRenderer.invoke('fs:createGroupFolder', data),
    // 📁 物理文件夹分组：重命名分组文件夹（同步迁移子文件夹内卡片路径）
    renameGroupFolder: (data) => ipcRenderer.invoke('fs:renameGroupFolder', data),
    // 📁 物理文件夹分组：移动卡片文件到目标分组文件夹
    moveCardToGroup: (data) => ipcRenderer.invoke('fs:moveCardToGroup', data),
    // 🧹 物理文件夹分组：删除空分组文件夹（删除卡片后自动清理空分组用，只删空目录）
    deleteEmptyGroupFolder: (data) => ipcRenderer.invoke('fs:deleteEmptyGroupFolder', data),
    // 📸 历史快照：更新快照配置（开关/冷却间隔/最大保留数）
    updateSnapshotConfig: (config) => ipcRenderer.invoke('settings:updateSnapshotConfig', config),
    // 📸 历史快照：手动为指定卡片创建快照（绕过冷却）
    createManualSnapshot: (filePath) => ipcRenderer.invoke('card:createManualSnapshot', filePath),
    // 📸 历史快照：列出指定卡片的历史快照（.bak_history 内，按时间倒序）
    listCardSnapshots: (filePath) => ipcRenderer.invoke('card:listSnapshots', filePath),
    // 📸 历史快照：从快照恢复指定卡片（先备份当前版本再覆盖）
    restoreCardSnapshot: (payload) => ipcRenderer.invoke('card:restoreSnapshot', payload),
    // 🗑️ 历史快照：删除指定卡片的一条历史快照
    deleteCardSnapshot: (snapshotPath) => ipcRenderer.invoke('card:deleteSnapshot', snapshotPath),
    // 🧹 历史快照：一键清理全部历史快照垃圾（递归删除库目录下所有 .bak_history，释放硬盘空间）
    cleanAllSnapshots: (libraryPath) => ipcRenderer.invoke('sys:cleanAllSnapshots', libraryPath),
    // 🧹 历史快照：清理孤儿快照目录（卡片已删除但 .bak_history 残留）
    cleanOrphanSnapshots: (libraryPath) => ipcRenderer.invoke('sys:cleanOrphanSnapshots', libraryPath),
    // 【已删除】getGlobalTags / saveGlobalTags / saveUiSettings：渲染层零调用（全局状态统一走 loadAppConfig/saveAppConfig）
    // 读取通用 UI 状态（旧环境 tavern_manager_config.json 只读回退，仅 app_config.json 不存在时使用）
    getUiSettings: () => ipcRenderer.invoke('config:getUiSettings'),
    // 🛡️ 统一持久化中枢：读取 app_config.json 全量配置（语言/分组/全局标签池/卡片覆盖层/API Key）
    loadAppConfig: () => ipcRenderer.invoke('sys:loadConfig'),
    // 🛡️ 统一持久化中枢：原子写入 app_config.json（全量替换，必须传完整配置对象）
    saveAppConfig: (configData) => ipcRenderer.invoke('sys:saveConfig', configData),
    // 读取图片二进制数据（用于解析内置 JSON）
    readBuffer: (filePath) => ipcRenderer.invoke('file:readBuffer', filePath),
    // 读取文本（用于 JSON 卡片）
    readText: (filePath) => ipcRenderer.invoke('file:readText', filePath),
    // 保存卡片 JSON 到本地文件
    saveCard: (filePath, updatedJson) => ipcRenderer.invoke('file:saveCard', filePath, updatedJson),
    // 📸 换角色卡图：选择新图并替换，返回新路径与校验校准报告
    replaceCardImage: (data) => ipcRenderer.invoke('card:replaceImage', data),
    // 原生消息对话框（替代 alert）
    showMessage: (options) => ipcRenderer.invoke('dialog:showMessage', options),
    // 系统级拖拽复制文件到卡片库
    copyToLibrary: (sourcePaths, targetFolder) => ipcRenderer.invoke('file:copyToLibrary', sourcePaths, targetFolder),
    // 🚀 全盘检索专属：外部卡片强行收编（只校验目标库，源为检索结果不校验；同名跳过）
    importExternalCards: (sourceFiles, destFolder) => ipcRenderer.invoke('sys:importExternalCards', sourceFiles, destFolder),
    // 获取拖拽文件的真实路径（Electron 33 起 File.path 已废弃，改用 webUtils）
    getPathForFile: (file) => webUtils.getPathForFile(file),
    // 聊天测试接口（OpenAI 兼容 / Anthropic 双协议，经主进程转发以绕过 CORS；apiType: 'openai' | 'anthropic'）
    sendChatMessage: (endpoint, payload, apiKey, apiType) => ipcRenderer.invoke('chat:send', endpoint, payload, apiKey, apiType),
    // 拉取服务端可用模型列表（GET /v1/models，经主进程转发以绕过 CORS）
    fetchModels: (endpoint, apiKey, apiType) => ipcRenderer.invoke('models:fetch', endpoint, apiKey, apiType),
    // 彻底删除本地文件（高危操作，需前端确认后调用）
    deleteFile: (filePath) => ipcRenderer.invoke('file:delete', filePath),
    // 一键导出角色卡完整整合包（主卡 + 独立世界书 + 正则脚本）
    exportPackage: (filePath, cardData) => ipcRenderer.invoke('file:exportPackage', filePath, cardData),
    // 批量打包导出多张卡片
    exportBatchPackage: (filePaths) => ipcRenderer.invoke('file:exportBatchPackage', filePaths),
    // 磁盘扫描：获取所有存在的盘符
    getWindowsDrives: () => ipcRenderer.invoke('get-windows-drives'),
    // 磁盘扫描：扫描指定盘符/文件夹（无参时主进程弹出原生目录选择器；useFilter 控制体积过滤；excludeFolder 排除当前库）
    scanTargetFolder: (targetPath, useFilter, excludeFolder) => ipcRenderer.invoke('scan-target-folder', targetPath, useFilter, excludeFolder),
    // 磁盘扫描：接收主进程扫描进度心跳
    onScanProgress: (callback) => {
        ipcRenderer.removeAllListeners('scan-progress'); // 防止重复绑定
        ipcRenderer.on('scan-progress', (event, data) => callback(data));
    },
    // 用系统资源管理器打开指定文件夹（查看快照/回收站等；相对路径自动解析）
    openPath: (targetPath) => ipcRenderer.invoke('system:openPath', targetPath),
    // 推送角色卡到酒馆（经主进程以 multipart 上传，绕过 CORS）
    pushToTavern: (params) => ipcRenderer.invoke('tavern:push', params),
    // 通用选择文件夹对话框（绑定酒馆本地根目录）
    selectGenericFolder: () => ipcRenderer.invoke('dialog:selectGenericFolder'),
    // 选择自定义卡库目录（TT 酒馆等任意角色卡目录）
    selectPushFolder: () => ipcRenderer.invoke('dialog:selectPushFolder'),
    // 智能嗅探酒馆本地根目录（遍历常见路径 + 指纹验证）
    autoDetectTavernPath: () => ipcRenderer.invoke('tavern:autoDetectPath'),
    // 物理拷贝卡片到酒馆 characters 目录（本地直推）
    pushToSillyTavernDir: (paths, rootPath) => ipcRenderer.invoke('tavern:pushDir', paths, rootPath),
    // 物理拷贝卡片到任意自定义卡库目录（TT 酒馆等）
    pushToCustomDir: (paths, targetDir) => ipcRenderer.invoke('library:pushToFolder', paths, targetDir),
    // 🌍 世界书专属通道：扫描目录下的 .json 世界书（返回含 entries 字段的合法世界书列表）
    scanWorldbooks: (dirPath) => ipcRenderer.invoke('wb:scan', dirPath),
    // 🌍 世界书专属通道：物理覆写世界书文件（保存前自动 .bak_history 快照备份）
    saveWorldbook: (params) => ipcRenderer.invoke('wb:save', params),
    // 🌍 世界书专属通道：从网络拉取世界书 JSON（主进程转发，绕开渲染层 CORS）
    fetchWbUrl: (url) => ipcRenderer.invoke('wb:fetchUrl', url),
    downloadCardFromUrl: (data) => ipcRenderer.invoke('card:downloadFromUrl', data),
    encryptSecret: (plain) => ipcRenderer.invoke('secret:encrypt', plain),
    decryptSecret: (cipher) => ipcRenderer.invoke('secret:decrypt', cipher),
    // 🌍 世界书专属通道：新建世界书文件（网址导入落盘）
    createWorldbook: (params) => ipcRenderer.invoke('wb:create', params),
    // 🌍 世界书专属通道：重命名世界书物理文件
    renameWorldbookFile: (params) => ipcRenderer.invoke('wb:rename', params),
    // 🌍 世界书专属通道：列表某本世界书的历史快照
    listWorldbookSnapshots: (filePath) => ipcRenderer.invoke('wb:listSnapshots', filePath),
    // 🌍 世界书专属通道：回滚到指定快照
    restoreWorldbookSnapshot: (payload) => ipcRenderer.invoke('wb:restoreSnapshot', payload),
    // 🌍 世界书专属通道：删除一条世界书历史快照
    deleteWorldbookSnapshot: (snapshotPath) => ipcRenderer.invoke('wb:deleteSnapshot', snapshotPath),
    // 🌍 世界书专属通道：批量导出已落盘世界书
    exportWorldbooksBatch: (filePaths) => ipcRenderer.invoke('wb:exportBatch', filePaths),
    // ⚙️ 预设专属通道：扫描目录下的 .json 预设文件
    scanPresets: (dirPath) => ipcRenderer.invoke('preset:scan', dirPath),
    // ⚙️ 预设专属通道：物理覆写预设文件（保存前自动快照备份）
    savePreset: (params) => ipcRenderer.invoke('preset:save', params),
    // ⚙️ 预设专属通道：新建预设文件
    createPreset: (params) => ipcRenderer.invoke('preset:create', params),
    // ⚙️ 预设专属通道：重命名预设物理文件
    renamePresetFile: (params) => ipcRenderer.invoke('preset:rename', params),
    // ⚙️ 预设专属通道：列表预设历史快照
    listPresetSnapshots: (filePath) => ipcRenderer.invoke('preset:listSnapshots', filePath),
    // ⚙️ 预设专属通道：回滚到指定预设快照
    restorePresetSnapshot: (payload) => ipcRenderer.invoke('preset:restoreSnapshot', payload),
    // ⚙️ 预设专属通道：删除一条预设历史快照
    deletePresetSnapshot: (snapshotPath) => ipcRenderer.invoke('preset:deleteSnapshot', snapshotPath),
    // ⚙️ 预设专属通道：批量导出已落盘预设
    exportPresetsBatch: (filePaths) => ipcRenderer.invoke('preset:exportBatch', filePaths),
    // 🗑️ 智能查重清洗：将冗余文件移动到 userData 下的全局回收站（绝不物理删除）
    trashFiles: (paths) => ipcRenderer.invoke('sys:trashFiles', paths),
    // 🗑️ 打开全局回收站（世界书删除/查重清洗的 userData/jsTavern_Trash）
    openGlobalTrash: () => ipcRenderer.invoke('sys:openGlobalTrash'),
    // 🕒 智能查重：批量获取文件物理状态（修改时间/创建时间/大小）
    getFileStats: (paths) => ipcRenderer.invoke('sys:getFileStats', paths),
    // 🖱️ 右键菜单：在系统资源管理器中打开并定位文件
    showItemInFolder: (filePath) => ipcRenderer.invoke('sys:showItemInFolder', filePath),
    // 🖱️ 右键菜单：物理复制文件（创建带时间戳的副本）
    duplicateFile: (filePath) => ipcRenderer.invoke('sys:duplicateFile', filePath),
    // 🚀 版本更新检测：用系统默认浏览器打开外部链接
    openExternal: (url) => ipcRenderer.invoke('sys:openExternal', url),
    // 🚀 OTA 自动更新：检查更新（触发后结果通过事件回调）
    checkUpdate: () => ipcRenderer.invoke('sys:checkUpdate'),
    // 🚀 OTA 自动更新：开始下载更新包
    downloadUpdate: () => ipcRenderer.invoke('sys:downloadUpdate'),
    // 🚀 OTA 自动更新：退出并安装更新
    installUpdate: () => ipcRenderer.invoke('sys:installUpdate'),
    // 🚀 OTA 自动更新：监听发现新版本
    onUpdateAvailable: (cb) => {
        ipcRenderer.removeAllListeners('update-available');
        ipcRenderer.on('update-available', (event, info) => cb(info));
    },
    // 🚀 OTA 自动更新：监听无新版本
    onUpdateNotAvailable: (cb) => {
        ipcRenderer.removeAllListeners('update-not-available');
        ipcRenderer.on('update-not-available', (event, info) => cb(info));
    },
    // 🚀 OTA 自动更新：监听下载进度
    onUpdateProgress: (cb) => {
        ipcRenderer.removeAllListeners('update-progress');
        ipcRenderer.on('update-progress', (event, progressObj) => cb(progressObj));
    },
    // 🚀 OTA 自动更新：监听下载完成
    onUpdateDownloaded: (cb) => {
        ipcRenderer.removeAllListeners('update-downloaded');
        ipcRenderer.on('update-downloaded', (event, info) => cb(info));
    },
    // 🚀 OTA 自动更新：监听更新错误
    onUpdateError: (cb) => {
        ipcRenderer.removeAllListeners('update-error');
        ipcRenderer.on('update-error', (event, err) => cb(err));
    }
});
