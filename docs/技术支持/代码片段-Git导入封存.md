> 📎 位置说明（2026-09-13 文档整理）：本文件原为 `docs/history/git-import-archive.md`，现归入**技术支持**文档。
> 内容是已**整体移除**的「Git 链接导入插件」功能的全部代码（主进程 IPC / preload 桥接 / 组合式函数 / UI 入口），供将来需要时按原样恢复（恢复说明见文末）。

# 🗄️ Git 链接导入功能封存档案

> 归档时间：本阶段决定「插件只支持 JSON 格式」，故将 Git 链接导入（下载 archive zip → 解压 → 重扫）功能整体从源代码剥离并存档于此。
> 本地扫描（plugin:scan）仍保留 `json` / `script` / `extension` 三种形态识别，此档案仅记录 **Git 链接导入入口** 相关的被移除代码。

---

## 1. `main.js` —— 顶部 unzipper 可选依赖声明（已移除）

```js
// 🧩 插件 Git zip 解压（可选依赖；打包缺失时回退到系统 Expand-Archive）
let unzipper = null;
try { unzipper = require('unzipper'); } catch (e) { unzipper = null; }
```

## 2. `main.js` —— Git 下载体积上限常量（已移除）

```js
const MAX_PLUGIN_DOWNLOAD_BYTES = 80 * 1024 * 1024; // 🧩 插件 Git 仓库 zip 下载上限
```

> 注意：`MAX_PLUGIN_SCRIPT_BYTES = 2 * 1024 * 1024` 仍被 `plugin:scan` / `plugin:readFile` 使用，**保留**。

## 3. `main.js` —— `plugin:downloadGit` IPC 处理器（已移除，约 3157-3250 行）

```js
  // 下载 Git 仓库 archive zip → 解压到插件目录（返回解压后的根目录）
  ipcMain.handle('plugin:downloadGit', async (event, { url, destDir } = {}) => {
    try {
      if (!url || !/^https?:\/\//i.test(url)) {
        return { success: false, error: '非法网址：仅支持 http/https 直链。' };
      }
      if (!destDir) return { success: false, error: '目标插件目录未设置。' };
      // 目标目录必须是白名单内的插件目录
      if (!isPathAllowed(destDir) || !fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
        return { success: false, error: '目标插件目录无效（未设置或不在合法范围内）。' };
      }

      // 1. 下载 zip 二进制
      const response = await net.fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (JSK-Manager; compatible)' },
        redirect: 'follow'
      });
      if (!response.ok) return { success: false, error: `网络请求失败 (状态码: ${response.status})` };
      const declaredLen = Number(response.headers.get('content-length') || 0);
      if (declaredLen > MAX_PLUGIN_DOWNLOAD_BYTES) {
        return { success: false, error: 'zip 体积过大（超过 80MB），已中止下载。' };
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (!buf || buf.length === 0) return { success: false, error: '下载内容为空。' };
      if (buf.length > MAX_PLUGIN_DOWNLOAD_BYTES) {
        return { success: false, error: 'zip 体积过大（超过 80MB），已中止下载。' };
      }
      // 校验是 zip（PK\x03\x04 头）
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
        return { success: false, error: '下载内容不是有效的 zip 压缩包（可能是 HTML 错误页）。' };
      }

      // 2. 解压到临时目录（防路径穿越 + 去顶层级）
      const tmpRoot = path.join(os.tmpdir(), `jsk-plugin-${process.pid}-${Date.now()}`);
      await fs.promises.mkdir(tmpRoot, { recursive: true });
      try {
        if (unzipper) {
          const directory = await unzipper.Open.buffer(buf);
          for (const file of directory.files) {
            const rel = file.path.replace(/\\/g, '/');
            if (rel.endsWith('/')) continue;
            if (rel.split('/').some(seg => seg === '..')) continue; // 防路径穿越
            const target = path.join(tmpRoot, rel);
            const targetResolved = path.resolve(target);
            if (!isPathUnder(targetResolved, tmpRoot)) continue;
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            const content = await file.buffer();
            await fs.promises.writeFile(target, content);
          }
        } else {
          // 回退：写临时 zip 文件 + 系统 Expand-Archive（仅 Windows）
          const zipPath = path.join(tmpRoot, 'repo.zip');
          await fs.promises.writeFile(zipPath, buf);
          if (process.platform !== 'win32') {
            throw new Error('当前环境缺少 zip 解压模块，请安装 unzipper 依赖。');
          }
          const { execFile } = require('child_process');
          await new Promise((resolve, reject) => {
            execFile('powershell.exe', [
              '-NoProfile', '-Command',
              `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmpRoot.replace(/'/g, "''")}' -Force`
            ], { timeout: 120000 }, (err) => err ? reject(err) : resolve());
          });
        }
      } catch (extractErr) {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
        throw new Error('解压失败: ' + (extractErr.message || extractErr));
      }

      // 3. 去掉 GitHub 顶层的 `<repo>-<branch>` 目录（挪平一层）
      let extractedRoot = tmpRoot;
      try {
        const top = await fs.promises.readdir(tmpRoot);
        const dirs = top.filter(n => {
          try { return fs.statSync(path.join(tmpRoot, n)).isDirectory(); } catch (e) { return false; }
        });
        if (dirs.length === 1) extractedRoot = path.join(tmpRoot, dirs[0]);
      } catch (e) { /* 保持原样 */ }

      // 4. 拷贝到插件目录（幂等导入：同名目录已存在则覆盖更新，避免重复导入产生多个带时间戳副本）
      const baseName = path.basename(extractedRoot);
      const finalDir = path.join(destDir, baseName);
      if (fs.existsSync(finalDir)) {
        await fs.promises.rm(finalDir, { recursive: true, force: true });
      }
      await fs.promises.cp(extractedRoot, finalDir, { recursive: true });
      await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      return { success: true, dir: finalDir };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
```

## 4. `preload.js` —— `downloadPluginGit` 桥接（已移除，约 138 行）

```js
    // 🧩 插件专属通道：下载 Git 仓库 archive zip 并解压到插件目录
    downloadPluginGit: (params) => ipcRenderer.invoke('plugin:downloadGit', params),
```

## 5. `js/composables/usePlugins.js` —— Git 导入相关（已移除）

### 5.1 状态声明

```js
    const isImportingPlugin = ref(false); // Git 导入中 loading 状态
    const importPluginUrl = ref('');      // Git 链接输入框绑定
```

### 5.2 `toArchiveZipUrl` 与 `importPluginFromGit`

```js
    // 把普通 GitHub 仓库页 URL 规整为 archive zip 直链（GitHub API 直连易失败）
    const toArchiveZipUrl = (url) => {
        const m = url.match(/github\.com\/([^\/\s]+)\/([^\/\s?#]+)/i);
        if (!m) return url; // 非 GitHub 链接原样返回
        const [, owner, repo] = m;
        const cleanRepo = repo.replace(/\.git$/i, '');
        // 若已带 /tree/<branch>，取 branch
        const bm = url.match(/\/tree\/([^\/?#]+)/i);
        const branch = bm ? bm[1] : 'main';
        return `https://github.com/${owner}/${cleanRepo}/archive/refs/heads/${branch}.zip`;
    };

    const importPluginFromGit = async () => {
        const url = importPluginUrl.value.trim();
        if (!url) {
            nativeAlert('请先粘贴插件的 Git 仓库链接！', 'warning');
            return;
        }
        if (!/^https?:\/\//i.test(url)) {
            nativeAlert('网址格式不正确，请粘贴以 http:// 或 https:// 开头的 Git 仓库链接。', 'warning');
            return;
        }

        // 确保有插件目录
        let destDir = lastPluginDirPath.value;
        if (!destDir) {
            addLog('未检测到上次插件目录，请选择保存位置...', 'warning');
            destDir = await window.electronAPI.selectGenericFolder();
            if (!destDir) return;
        }
        lastPluginDirPath.value = destDir;
        try { localStorage.setItem('jsTavern_lastPluginDir', destDir); } catch (e) { /* 忽略 */ }

        const zipUrl = toArchiveZipUrl(url);
        isImportingPlugin.value = true;
        try {
            addLog(`开始导入插件仓库: ${url}`);
            if (zipUrl !== url) addLog(`已解析为 archive 直链: ${zipUrl}`);
            const res = await window.electronAPI.downloadPluginGit({ url: zipUrl, destDir });
            if (res.success) {
                addLog(`🎉 插件已导入到: ${res.dir}`, 'success');
                nativeAlert(`🎉 插件导入成功！\n已解压到:\n${res.dir}`, 'info');
                importPluginUrl.value = '';
                await scanPluginDir(destDir); // 重扫，让新插件立即出现在列表
            } else {
                nativeAlert(`导入失败: ${res.error}`, 'error');
            }
        } catch (error) {
            console.error('插件导入失败:', error);
            addLog(`❌ 插件导入失败: ${error.message}`, 'error');
            nativeAlert(`❌ 导入失败！\n错误详情: ${error.message}`, 'error');
        } finally {
            isImportingPlugin.value = false;
        }
    };
```

### 5.3 `return` 中的导出项

```js
    return {
        // 状态
        pluginSearchQuery,
        isImportingPlugin,
        importPluginUrl,
        // ...
        // Git 导入
        importPluginFromGit,
        toArchiveZipUrl,
        // ...
    };
```

## 6. `js/components/SidebarPanel.vue` —— Git 输入框 + 按钮（已移除，约 559-565 行）

```html
                    <input v-model="importPluginUrl" type="text" placeholder="Git 仓库链接..."
                           title="粘贴 GitHub 等仓库链接，下载源码包并解压到插件目录"
                           class="flex-[2] min-w-0 h-8 bg-zinc-800/80 border border-zinc-700/60 rounded-lg px-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-violet-500/80 transition">
                    <button @click="importPluginFromGit" :disabled="isImportingPlugin"
                            title="从 Git 仓库导入插件"
                            class="px-2.5 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-xs rounded border border-violet-700/60 transition">
                        {{ isImportingPlugin ? '⏳' : '⬇️' }}
                    </button>
```

### 6.1 对应的 setup return 导出

```js
            importPluginUrl: ctx.importPluginUrl,
            isImportingPlugin: ctx.isImportingPlugin,
            importPluginFromGit: ctx.importPluginFromGit,
```

## 7. `js/components/App.vue` —— usePlugins 解构中的 Git 项（已移除）

```js
        const {
            pluginSearchQuery, isImportingPlugin, importPluginUrl,
            loadPlugins, scanPluginDir, filteredPlugins,
            importPluginFromGit, deletePlugin,
            openPluginContextMenu, openPluginInFolder, readPluginSource
        } = usePlugins({ ... });
```

> 移除后变为：
> ```js
>         const {
>             pluginSearchQuery,
>             loadPlugins, scanPluginDir, filteredPlugins,
>             deletePlugin,
>             openPluginContextMenu, openPluginInFolder, readPluginSource
>         } = usePlugins({ ... });
> ```

以及对应的 setup return 导出项 `pluginSearchQuery, isImportingPlugin, importPluginUrl, ... importPluginFromGit, ...` 中移除 `isImportingPlugin` / `importPluginUrl` / `importPluginFromGit`。

---

## 恢复说明

如需重新启用 Git 链接导入，按上述各文件位置反向回填即可：
1. `main.js` 顶部恢复 `unzipper` 声明 + `MAX_PLUGIN_DOWNLOAD_BYTES` 常量；
2. `main.js` 恢复 `plugin:downloadGit` handler；
3. `preload.js` 恢复 `downloadPluginGit` 桥接；
4. `usePlugins.js` 恢复状态声明 / `toArchiveZipUrl` / `importPluginFromGit` / return 导出；
5. `SidebarPanel.vue` 恢复输入框 + 按钮 + return 导出；
6. `App.vue` 恢复解构与 return 导出。
