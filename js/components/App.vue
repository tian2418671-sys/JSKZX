<template>
<div :style="{
        '--workspace-fs': appSettings.fontSize + 'px',
        fontFamily: appSettings.fontFamily,
        fontWeight: appSettings.fontWeight
    }" class="h-full flex flex-col text-[13px]"
         @dragenter="handleDragEnter"
         @dragleave="handleDragLeave"
         @dragover.prevent
         @drop="handleDrop">

        <!-- 拖拽导入全屏遮罩（子组件 DragOverlay） -->
        <drag-overlay :is-dragging="isDragging" />

        <!-- 启动过渡蒙版（子组件 AppLoadingOverlay） -->
        <app-loading-overlay :is-loading="isAppLoading" />
        
        <!-- ================= [ 顶部菜单栏 + 紧凑工具栏（子组件 HeaderBar） ] ================= -->
        <header-bar />

        <!-- ================= [ 主工作区 (左右分栏) ] ================= -->
        <div class="flex-1 flex overflow-hidden">
            
            <!-- 【左侧】资源管理器 + 拖拽调宽把手（子组件 SidebarPanel） -->
            <sidebar-panel />

            <!-- 【右侧】编辑器面板（子组件 EditorPanel） -->
            <editor-panel />
        </div>

        <!-- ================= [ 弹窗：单卡添加标签（子组件 SingleTagModal） ] ================= -->
        <single-tag-modal
            :show="tagModalVisible"
            :title="tagModalTitle"
            :model-value="tagInput"
            @update:model-value="tagInput = $event"
            @confirm="confirmSingleTag"
            @close="closeSingleTagModal"
        />

        <!-- ================= [ 弹窗：通用输入（子组件 PromptModal，替代 prompt） ] ================= -->
        <prompt-modal
            :show="promptModalVisible"
            :title="promptModalTitle"
            :model-value="promptInput"
            @update:model-value="promptInput = $event"
            @confirm="confirmPrompt"
            @cancel="cancelPrompt"
        />

        <!-- ================= [ 弹窗：通用选项选择（子组件 OptionSelectModal，替代手输名称） ] ================= -->
        <option-select-modal
            :show="selectModalVisible"
            :title="selectModalTitle"
            :options="selectModalOptions"
            :default-value="selectModalDefault"
            :allow-create="selectModalAllowCreate"
            @select="confirmSelect"
            @create="confirmSelectCreate"
            @cancel="cancelSelect"
        />

        <!-- ================= [ 弹窗：批量标签（子组件 BatchTagModal） ] ================= -->
        <batch-tag-modal
            :show="showBatchTagModal"
            :selected-count="selectedIds.length"
            :batch-mode="batchMode"
            :batch-input-tags="batchInputTags"
            :batch-tag-chips="batchTagChips"
            :system-common-tags="systemCommonTags"
            @close="showBatchTagModal = false"
            @confirm="executeBatchTagSave"
            @update:batch-mode="batchMode = $event"
            @update:batch-input-tags="batchInputTags = $event"
            @remove-batch-tag="removeBatchTag($event)"
            @toggle-common-tag="toggleBatchCommonTag($event)"
            @remove-system-common-tag="removeTagFromGlobalPool"
        />

        <!-- ================= [ 弹窗：AI 智能批量打标（子组件 AITagModal） ] ================= -->
        <ai-tag-modal
            :show="showAITagModal"
            :selected-count="selectedIds.length"
            :system-common-tags="systemCommonTags"
            :ai-candidate-tags="aiCandidateTags"
            :new-a-i-candidate-tag="newAICandidateTag"
            :enable-a-i-extraction="enableAIExtraction"
            :custom-a-i-prompt="customAIPrompt"
            :use-jailbreak="useJailbreak"
            :jailbreak-prompt="jailbreakPrompt"
            :jailbreak-presets="jailbreakPresets"
            :system-prompt-presets="systemPromptPresets"
            :active-system-prompt-id="activeSystemPromptId"
            :api-endpoint="apiEndpoint"
            :api-key="apiKey"
            :api-model="apiModel"
            :available-models="availableModels"
            :is-fetching-models="isFetchingModels"
            :fetch-model-status="fetchModelStatus"
            :is-a-i-tagging="isAITagging"
            :ai-tagging-progress="aiTaggingProgress"
            :use-local-vector="useLocalVector"
            :vector-threshold="vectorThreshold"
            :vector-top-k="vectorTopK"
            :vector-status="vectorStatus"
            :vector-downloading="vectorDownloading"
            :vector-download-progress="vectorDownloadProgress"
            :vector-download-source="vectorDownloadSource"
            @close="showAITagModal = false"
            @remove-ai-candidate-tag="removeAICandidateTag"
            @update:newAICandidateTag="newAICandidateTag = $event"
            @add-ai-candidate-tag-manual="addAICandidateTagManual"
            @add-ai-candidate-tag="addAICandidateTag"
            @update:enableAIExtraction="enableAIExtraction = $event"
            @update:customAIPrompt="customAIPrompt = $event"
            @update:useJailbreak="useJailbreak = $event"
            @update:jailbreakPrompt="jailbreakPrompt = $event"
            @add-system-prompt-preset="addSystemPromptPreset"
            @update:activeSystemPromptId="activeSystemPromptId = $event"
            @save-system-prompts="saveSystemPromptsToStorage"
            @delete-system-prompt-preset="deleteSystemPromptPreset"
            @fetch-available-models="fetchAvailableModels"
            @update:apiEndpoint="apiEndpoint = $event"
            @update:apiKey="apiKey = $event"
            @update:apiModel="apiModel = $event"
            @start-tagging="startAITagging"
            @remove-system-common-tag="removeTagFromGlobalPool"
            @update:useLocalVector="useLocalVector = $event"
            @update:vectorThreshold="vectorThreshold = $event"
            @update:vectorTopK="vectorTopK = $event"
            @init-vector-engine="initVectorEngine"
            @delete-vector-cache="deleteVectorCache"
            @open-auto-tag-rules="showAutoTagRulesModal = true"
        />

        <!-- ================= [ 📝 自动打标规则表编辑弹窗（v2.1 可配置） ] ================= -->
        <auto-tag-rules-modal
            :show="showAutoTagRulesModal"
            :rules="autoTagRules"
            :custom-keywords="customKeywords"
            @close="showAutoTagRulesModal = false"
            @save="saveAutoTagRules"
            @reset="resetAutoTagRules"
            @add-keyword="addCustomKeyword"
            @remove-keyword="removeCustomKeyword"
        />

        <!-- ================= [ 弹窗：关系图谱（子组件 GraphModal） ] ================= -->
        <graph-modal
            :show="showGraph"
            :graph-layout-mode="graphLayoutMode"
            :isolate-current-group="isolateCurrentGroup"
            :edge-filters="edgeFilters"
            :graph-search-keyword="graphSearchKeyword"
            :min-link-weight="minLinkWeight"
            :graph-stats="graphStats"
            :building="graphBuilding"
            @update-graph-layout="updateGraphLayout"
            @update:isolateCurrentGroup="isolateCurrentGroup = $event"
            @update:graphSearchKeyword="graphSearchKeyword = $event"
            @update:minLinkWeight="minLinkWeight = $event"
            @render="renderGraph"
            @export="exportGraph"
            @close="closeGraph"
        />

        <!-- ================= [ 弹窗：全局资产中心（子组件 GlobalAssetModal） ] ================= -->
        <!-- v-if 惰性挂载：避免加载/入库期间每次都触发 globalAllWorldbooks/globalAllRegexScripts 两处全库遍历 -->
        <global-asset-modal
            v-if="showGlobalAssetModal"
            :show="showGlobalAssetModal"
            :asset-tab="globalAssetTab"
            :all-worldbooks="globalAllWorldbooks"
            :all-regex-scripts="globalAllRegexScripts"
            @close="showGlobalAssetModal = false"
            @update:assetTab="globalAssetTab = $event"
        />

        <!-- ================= [ 右键快捷菜单：角色卡（子组件 ContextMenu） ] ================= -->
        <context-menu
            :visible="contextMenu.visible"
            :x="contextMenu.x"
            :y="contextMenu.y"
            :item="contextMenu.item"
            @view="openFromLibrary(contextMenu.item); closeContextMenu()"
            @open-folder="handleContextMenuAction('openFolder')"
            @duplicate="handleContextMenuAction('duplicate')"
            @move-group="quickMoveGroup(contextMenu.item); closeContextMenu()"
            @export="exportCard(contextMenu.item); closeContextMenu()"
            @push-target="handleContextMenuAction('pushTarget')"
            @ai-tag="handleContextMenuAction('aiTag')"
            @snapshots="handleContextMenuAction('snapshots')"
            @replace-image="replaceCardImage(contextMenu.item); closeContextMenu()"
            @trash="handleContextMenuAction('trash')"
        />

        <!-- ================= [ 右键快捷菜单：世界书（子组件 WbContextMenu） ] ================= -->
        <wb-context-menu
            :show="wbContextMenu.show"
            :x="wbContextMenu.x"
            :y="wbContextMenu.y"
            :wb="wbContextMenu.wb"
            @open-folder="openWbInFolder(wbContextMenu.wb); closeWbContextMenu()"
            @rename="renameWorldbook(wbContextMenu.wb); closeWbContextMenu()"
            @duplicate="duplicateWorldbook(wbContextMenu.wb); closeWbContextMenu()"
            @move-group="changeWbCategory(wbContextMenu.wb); closeWbContextMenu()"
            @delete="deleteWorldbook(wbContextMenu.wb); closeWbContextMenu()"
        />

        <!-- ================= [ 弹窗：全屏大文本阅读/编辑（子组件 TextModal） ] ================= -->
        <text-modal
            :show="showTextModal"
            :title="textModalTitle"
            :model-value="textModalContent"
            :font-size="textModalFontSize"
            @update:model-value="textModalContent = $event"
            @update:font-size="textModalFontSize = $event"
            @save="saveTextModal"
            @close="showTextModal = false"
        />

        <!-- ================= [ 弹窗：高清立绘大图预览（子组件 ImageModal） ] ================= -->
        <image-modal
            :show="showImageModal"
            :url="previewImageUrl"
            @close="showImageModal = false"
        />

        <!-- ================= [ 弹窗：历史快照列表与一键恢复（子组件 SnapshotModal） ] ================= -->
        <snapshot-modal
            :show="showSnapshotModal"
            :snapshots="snapshotList"
            :card-name="snapshotCardName"
            :card-path="snapshotCardPath"
            @close="closeSnapshotModal"
            @restore="restoreSnapshot"
            @delete="deleteSnapshot"
            @open-folder="openSnapshotFolder"
        />

        <!-- ================= [ 弹窗：🚀 推送目标选择与执行（子组件 PushModal） ] ================= -->
        <push-modal
            :show="showPushModal"
            :selected-count="selectedIds.length"
            :current-card-name="(currentOpenCardItem && currentOpenCardItem.name) || ''"
            @close="showPushModal = false"
        />

        <!-- ================= [ 弹窗：API 引擎与模型设置（子组件 ApiSettingsModal） ] ================= -->
        <api-settings-modal
            :show="showApiModal"
            :api-type="apiType"
            :api-endpoint="apiEndpoint"
            :api-key="apiKey"
            :api-model="apiModel"
            :available-models="availableModels"
            :is-fetching-models="isFetchingModels"
            :fetch-model-status="fetchModelStatus"
            :tavern-local-path="appSettings.tavernLocalPath"
            @close="showApiModal = false"
            @update:apiType="apiType = $event"
            @api-type-change="handleApiTypeChange"
            @update:apiEndpoint="apiEndpoint = $event"
            @update:apiKey="apiKey = $event"
            @update:apiModel="apiModel = $event"
            @fetch-models="fetchAvailableModels"
            @rebind-path="rebindTavernPath"
            @clear-path="appSettings.tavernLocalPath = ''"
            @save="saveApiConfig"
        />

        <!-- 模型名称下拉建议（供聊天面板与设置弹窗共用；置于常驻 DOM 避免被 v-if 移除） -->
        <datalist id="model-suggestions">
            <option value="local-model">本地 LM Studio / Ollama 默认</option>
            <option value="gpt-3.5-turbo">ChatGPT 3.5 速度快</option>
            <option value="gpt-4o">ChatGPT 4o 最聪明</option>
            <option value="gpt-4o-mini">ChatGPT 4o mini 经济</option>
            <option value="claude-3-5-sonnet">Claude 3.5 Sonnet 文本好</option>
            <option value="qwen2.5-7b-instruct">本地 Qwen 7B</option>
        </datalist>

        <!-- ================= [ 🛰️ 全盘深度检索引擎弹窗（子组件 DiskScanModal） ] ================= -->
        <disk-scan-modal
            :show="showDiskScanModal"
            :current-library-path="currentFolderPath"
            :open-library="selectFixedDirectory"
            @close="showDiskScanModal = false"
            @imported="handleScanImported"
        />

        <!-- ================= [ 🔍 智能查重与版本清洗弹窗（子组件 DedupeModal） ] ================= -->
        <dedupe-modal
            :show="showDedupeModal"
            :groups="duplicateGroups"
            @close="showDedupeModal = false"
            @open-diff="openDiffDetailModal"
            @resolve-group="resolveDedupeGroup"
        />

        <!-- ================= [ 📖 世界书智能版本对比查重弹窗（子组件 WbDedupeModal） ] ================= -->
        <wb-dedupe-modal
            :show="showWbDedupeModal"
            :groups="wbDuplicateGroups"
            @close="showWbDedupeModal = false"
            @open-diff="openDiffDetailModal"
            @resolve-group="resolveWbDedupeGroup"
        />

        <!-- ================= [ ⚙️ 预设智能查重弹窗（子组件 PresetDedupeModal） ] ================= -->
        <preset-dedupe-modal
            :show="showPresetDedupeModal"
            :groups="presetDuplicateGroups"
            @close="showPresetDedupeModal = false"
            @open-diff="openDiffDetailModal"
            @resolve-group="resolvePresetDedupeGroup"
        />

        <!-- ================= [ 🧬 内容级跨名称版本查重弹窗（子组件 ContentDedupeModal） ] ================= -->
        <content-dedupe-modal
            :show="showContentDedupeModal"
            :groups="contentDuplicateGroups"
            @close="showContentDedupeModal = false"
            @open-diff="openDiffDetailModal"
            @resolve-group="resolveContentDedupeGroup"
        />

        <!-- ================= [ ⚖️ 数据版本差异深度比对 (Diff Inspector)（子组件 DiffModal） ] ================= -->
        <diff-modal
            :show="showDiffDetailModal"
            :master-item="diffMasterItem"
            :compare-item="diffCompareItem"
            :field-results="diffFieldResults"
            @close="showDiffDetailModal = false"
        />

    <!-- ================= [ 🌐 世界书词条逻辑关联图谱（子组件 WbGraphModal） ] ================= -->
    <wb-graph-modal
        :show="showWbGraphModal"
        :layout="wbGraphLayout"
        :search="wbGraphSearch"
        :filters="wbGraphFilters"
        :min-weight="wbGraphMinWeight"
        :stats="wbGraphStats"
        :building="wbGraphBuilding"
        @update-layout="updateWbGraphLayout"
        @update:search="wbGraphSearch = $event"
        @update:minWeight="wbGraphMinWeight = $event"
        @render="renderWbGraph"
        @export="exportWbGraph"
        @close="closeWbGraphModal"
    />

    <!-- ================= [ 🔗 多本世界书智能合并（子组件 WbMergeModal） ] ================= -->
    <wb-merge-modal
        :show="showWbMergeModal"
        :worldbooks="worldbooks"
        :selected-paths="selectedWbMergePaths"
        @close="showWbMergeModal = false"
        @update:selectedPaths="selectedWbMergePaths = $event"
        @merge="executeWorldbookMerge"
    />

    <!-- ================= [ 🔀 条目级导入合并弹窗（子组件 WbImportModal） ] ================= -->
    <wb-import-modal
        :show="showWbImportModal"
        :active-worldbook-name="(activeWorldbook && activeWorldbook.data && activeWorldbook.data.name) || '未命名'"
        :source-books="importableSourceBooks"
        :source-book="importSourceBook"
        :candidates="importCandidates"
        :selected-entries="selectedImportEntries"
        @close="showWbImportModal = false"
        @pick-source="pickImportSource"
        @update:selectedEntries="selectedImportEntries = $event"
        @confirm-import="confirmImportEntries"
    />

    <!-- ================= [ 📥 从世界书库导入词条到角色卡弹窗（复用 WbImportModal 子组件） ] ================= -->
    <wb-import-modal
        :show="showCardWbImportModal"
        :active-worldbook-name="safeData.name || '当前角色卡'"
        :source-books="worldbooks"
        :source-book="cardWbImportSource"
        :candidates="cardWbImportCandidates"
        :selected-entries="cardWbSelectedEntries"
        @close="showCardWbImportModal = false"
        @pick-source="pickCardWbImportSource"
        @update:selectedEntries="cardWbSelectedEntries = $event"
        @confirm-import="confirmCardWbImport"
    />

    <!-- ================= [ 🔎 全库词条搜索与反向引用（子组件 GlobalEntrySearchModal） ] ================= -->
    <global-entry-search-modal
        :show="showGlobalEntrySearchModal"
        v-model:query="globalEntrySearchQuery"
        :results="globalEntrySearchResults"
        :index-count="globalEntryIndex.length"
        @close="closeGlobalEntrySearch"
        @jump="jumpToEntrySource"
    />

    <!-- ================= [ 🕒 世界书快照历史与回滚（子组件 WbSnapshotModal） ] ================= -->
    <wb-snapshot-modal
        :show="showWbSnapshotModal"
        :target-name="(wbSnapshotTarget && wbSnapshotTarget.data && wbSnapshotTarget.data.name) || (wbSnapshotTarget && wbSnapshotTarget.name) || '未命名'"
        :snapshots="wbSnapshotList"
        @close="closeWbSnapshotModal"
        @restore="restoreWbSnapshot"
        @delete="deleteWbSnapshot"
    />

    <!-- ================= [ 弹窗：版本更新检测（子组件 UpdateModal） ] ================= -->
    <update-modal
        :show="showUpdateModal"
        :info="updateInfo"
        :error-msg="updateErrorMsg"
        @close="showUpdateModal = false"
    />

    <!-- ================= [ 🔔 新版本角落提醒浮标（右下角常驻，静默检测到新版时点亮；点击查看详情） ] ================= -->
    <transition name="fade">
        <div v-if="showUpdateBadge && !showUpdateModal" class="fixed bottom-5 right-5 z-[90] select-none">
            <div class="flex items-center gap-2.5 pl-3.5 pr-2 py-2.5 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white rounded-full shadow-[0_4px_24px_rgba(16,185,129,0.45)] cursor-pointer hover:scale-105 transition-transform duration-200" title="点击查看新版本详情" @click="showUpdateModal = true">
                <span class="relative flex h-2.5 w-2.5 shrink-0">
                    <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60"></span>
                    <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-white"></span>
                </span>
                <span class="text-xs font-bold whitespace-nowrap">🚀 发现新版本 <span class="font-mono underline underline-offset-2 decoration-white/50">v{{ updateInfo.latestVersion }}</span></span>
                <button class="w-5 h-5 flex items-center justify-center rounded-full hover:bg-white/25 text-white/80 hover:text-white transition text-[10px] shrink-0" title="本次启动内不再提醒" @click.stop="dismissUpdateBadge">✕</button>
            </div>
        </div>
    </transition>

        <!-- ================= [ 全局 Toast 消息通知（子组件 ToastContainer） ] ================= -->
        <toast-container :toasts="toasts" />

        <!-- ================= [ 批量操作悬浮控制台（可拖动：按住标题栏拖动，双击标题栏复位底部居中） ] ================= -->
        <div v-if="selectedIds.length > 0"
             class="fixed z-50 bg-gray-800/95 backdrop-blur-sm text-zinc-100 p-2.5 flex flex-col gap-1.5 shadow-2xl text-xs border border-gray-700 rounded-xl"
             :style="batchBarStyle">
            <div class="flex justify-between items-center px-1 cursor-grab select-none active:cursor-grabbing"
                 title="按住此处可随意拖动；双击复位到底部居中"
                 @mousedown="startBatchBarDrag"
                 @dblclick="resetBatchBarPos">
                <span class="font-bold text-blue-400">已勾选 {{ selectedIds.length }} 张卡片</span>
                <div class="flex items-center gap-2">
                    <span class="text-[10px] text-gray-500 select-none">⠿ 可拖动</span>
                    <button @click="clearSelection" class="text-gray-400 hover:text-zinc-100">取消选择 ✕</button>
                </div>
            </div>
            <div class="grid grid-cols-5 gap-1">
                <button @click="batchChangeCategoryModal" class="bg-gray-700 hover:bg-blue-600 py-1.5 rounded transition font-medium">📁 移分组</button>
                <button @click="showBatchTagModal = true" class="bg-gray-700 hover:bg-purple-600 py-1.5 rounded transition font-medium">🏷️ 贴标签</button>
                <button @click="openAITagModal" class="bg-gray-700 hover:bg-amber-600 py-1.5 rounded transition font-medium">🤖 AI 打标</button>
                <button @click="batchExportSelected" class="bg-gray-700 hover:bg-emerald-600 py-1.5 rounded transition font-medium">📦 导出</button>
                <button @click="batchDeleteSelected" class="bg-gray-700 hover:bg-red-600 py-1.5 rounded transition font-medium" title="将选中的卡片批量移入回收站">🗑️ 删除</button>
            </div>
        </div>

    </div>
</template>

<script>
import { ref, shallowRef, reactive, computed, watch, onMounted, onUnmounted, nextTick, triggerRef, provide, toRaw } from 'vue';
import DOMPurify from 'dompurify'; // 渲染模式 XSS 清洗（本地依赖，随 Vite 打包，离线可用）
import * as echarts from 'echarts'; // ECharts 由 npm 依赖提供（替代旧全局 script）
import Section from './Section.vue'; // SFC 单文件组件（由 Section.js 迁移）
import DragOverlay from './DragOverlay.vue'; // 拖拽导入全屏遮罩
import AppLoadingOverlay from './AppLoadingOverlay.vue'; // 启动过渡蒙版
import ToastContainer from './ToastContainer.vue'; // 全局 Toast 消息容器
import BatchTagModal from './BatchTagModal.vue'; // 批量设置标签弹窗
import PromptModal from './PromptModal.vue'; // 通用输入弹窗（替代 prompt）
import OptionSelectModal from './OptionSelectModal.vue'; // 通用选项选择弹窗（替代手输名称，右键换组等）
import SingleTagModal from './SingleTagModal.vue'; // 单卡添加标签弹窗
import DiskScanModal from './DiskScanModal.vue'; // 磁盘扫描进度弹窗
import UpdateModal from './UpdateModal.vue'; // 版本更新检测弹窗
import TextModal from './TextModal.vue'; // 全屏大文本阅读/编辑弹窗
import ImageModal from './ImageModal.vue'; // 高清立绘大图预览弹窗
import ApiSettingsModal from './ApiSettingsModal.vue'; // API 引擎与模型设置弹窗
import GlobalAssetModal from './GlobalAssetModal.vue'; // 全局世界书与正则资产中心弹窗
import GraphModal from './GraphModal.vue'; // 角色宇宙关系图谱弹窗
import WbGraphModal from './WbGraphModal.vue'; // 世界书词条逻辑关联图谱弹窗
import DedupeModal from './DedupeModal.vue'; // 智能版本查重中心弹窗
import WbDedupeModal from './WbDedupeModal.vue'; // 世界书智能版本对比查重弹窗
import PresetDedupeModal from './PresetDedupeModal.vue'; // 预设智能查重弹窗
import ContentDedupeModal from './ContentDedupeModal.vue'; // 🧬 内容级跨名称版本查重弹窗
import DiffModal from './DiffModal.vue'; // 数据版本差异深度比对弹窗
import WbMergeModal from './WbMergeModal.vue'; // 多本世界书智能合并弹窗
import WbImportModal from './WbImportModal.vue'; // 条目级导入合并弹窗
import GlobalEntrySearchModal from './GlobalEntrySearchModal.vue'; // 🔎 全库词条搜索弹窗
import WbSnapshotModal from './WbSnapshotModal.vue'; // 🕒 世界书快照历史弹窗
import ContextMenu from './ContextMenu.vue'; // 角色卡右键快捷菜单
import WbContextMenu from './WbContextMenu.vue'; // 世界书右键快捷菜单
import AiTagModal from './AITagModal.vue'; // AI 智能批量打标弹窗（⚠️ 注册名须用 AiTagModal，kebab 标签 ai-tag-modal 解析为 AiTagModal 而非 AITagModal）
import AutoTagRulesModal from './AutoTagRulesModal.vue'; // 📝 自动打标规则表编辑弹窗（v2.1 可配置）
import HeaderBar from './HeaderBar.vue'; // 顶部菜单栏 + 紧凑工具栏
import SidebarPanel from './SidebarPanel.vue'; // 左侧资源管理器（角色卡/世界书库）+ 拖拽把手
import EditorPanel from './EditorPanel.vue'; // 右侧编辑器面板（角色卡编辑 + 世界书 IDE + 日志控制台）
import SnapshotModal from './SnapshotModal.vue'; // 📸 历史快照列表与一键恢复弹窗
import PushModal from './PushModal.vue'; // 🚀 推送目标选择与执行对话框
import { processFile, extractBookEntries, compileAutoTagRules, defaultAutoTagRules } from '../utils/cardLoader.js';
// normalizeCardData / isCharacterCardData / autoTagRules（cardLoader）与 parsePNGChunk / deepScanForJSON（pngParser）
// 已随导入入库域迁移至 useCardCrud 组合式函数，由其自行 import
import { estimateTokens } from '../utils/tokenEstimate.js'; // Token 估算（与 TextModal 共享）
import { useSnapshots } from '../composables/useSnapshots.js'; // 📸 历史快照功能（拆分出的组合式函数）
import { useCardCrud } from '../composables/useCardCrud.js'; // 🃏 卡片 CRUD（导入入库/删除回收/持久化保存/导出重命名，从 App.vue 拆分）
import { useConfigPersistence } from '../composables/useConfigPersistence.js'; // 🛡️ 统一配置持久化中枢（app_config.json 收集/加密/落盘/防抖，从 App.vue 拆分）
import { useEmbeddedWorldbook } from '../composables/useEmbeddedWorldbook.js'; // 🌍 角色卡内嵌世界书编辑（条目派生/uid/折叠展开/触发词工具，从 App.vue 拆分）
import { useStatusbarPreview } from '../composables/useStatusbarPreview.js'; // 📊 状态栏预览器（正则脚本渲染效果所见即所得 + 内置模板注入）
import { useCardGroups } from '../composables/useCardGroups.js'; // 📁 角色卡分组/分类功能（拆分出的组合式函数）
import { useDedupe } from '../composables/useDedupe.js'; // 🔍 查重与差异比对功能（拆分出的组合式函数）
import { useWorldbooks } from '../composables/useWorldbooks.js'; // 🌍 世界书库与分组功能（拆分出的组合式函数）
import { usePresets } from '../composables/usePresets.js'; // ⚙️ 酒馆预设管理功能
import { useWorldbookEntries } from '../composables/useWorldbookEntries.js'; // 📚 世界书词条深度编辑（Entry IDE）组合式函数
import { useGlobalEntrySearch } from '../composables/useGlobalEntrySearch.js'; // 🔎 全库词条搜索与反向引用组合式函数
import { useWorldbookExtras } from '../composables/useWorldbookExtras.js'; // 📤 世界书扩展：提取/JSONL导入/批量导出/快照/统计
import { useAITools } from '../composables/useAITools.js'; // ✨ AI 打标/翻译/格式升维功能（拆分出的组合式函数）
import { useTags } from '../composables/useTags.js'; // 🏷️ 标签系统（批量标签/预设标签/系统标签池/中英切换/全局标签库）组合式函数
import { useChat } from '../composables/useChat.js'; // 💬 聊天测卡（聊天历史/发送/API 设置/模型拉取）组合式函数
import { useSearch, extractCardSearchableText, extractCardTags } from '../composables/useSearch.js'; // 🔎 超级搜索引擎（搜索防抖/全字段过滤/分页）组合式函数
import { useGraph } from '../composables/useGraph.js'; // 🕸️ 关系图谱（角色宇宙关系图谱生成/渲染）组合式函数
import { useDiskScan } from '../composables/useDiskScan.js'; // 💽 磁盘卡片扫描（全盘扫描/收编/刷新目录）组合式函数
import { useBatch } from '../composables/useBatch.js'; // ✅ 批量操作（多选/批量导出/批量删除/批量打标）组合式函数
import searchIndex from '../utils/searchIndex.js'; // 🚀 高性能搜索索引引擎
import tokenCache from '../utils/tokenCache.js'; // 🚀 Token 估算缓存

/** 用户可读的错误提示映射 */
const ERROR_MESSAGES = {
    NO_CARD_DATA: '未能提取到有效的角色卡数据。这可能不是一张标准格式的 Tavern 图片卡，或者数据已损坏。',
    DEFAULT: '文件读取或解析失败，请检查文件是否损坏。'
};

// 🔎 超级搜索引擎辅助函数（extractCardSearchableText / extractCardTags）已移入 useSearch.js

// ================= 渲染进程全局错误兜底 =================
window.addEventListener('error', (event) => {
    console.error('[全局错误]', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
    console.error('[未处理的 Promise 拒绝]', event.reason);
});

// ================= [ 阻止 Electron 默认打开拖入的文件 ] =================
// 全局按住浏览器的默认拖拽行为，禁止它私自打开/导航到文件（纵深防御，覆盖 #app 之外的边缘区域）
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

export default {
    components: { Section, DragOverlay, AppLoadingOverlay, ToastContainer, BatchTagModal, PromptModal, OptionSelectModal, SingleTagModal, DiskScanModal, UpdateModal, TextModal, ImageModal, ApiSettingsModal, GlobalAssetModal, GraphModal, WbGraphModal, DedupeModal, WbDedupeModal, PresetDedupeModal, ContentDedupeModal, DiffModal, WbMergeModal, WbImportModal, GlobalEntrySearchModal, WbSnapshotModal, ContextMenu, WbContextMenu, AiTagModal, AutoTagRulesModal, HeaderBar, SidebarPanel, EditorPanel, SnapshotModal, PushModal },
    setup() {
        // 主题状态（localStorage 在自定义协议下可能不可用，做防御性读取；默认暗夜极客）
        let savedTheme = 'dark';
        try { savedTheme = localStorage.getItem('stc-theme') || 'dark'; } catch (e) { /* 忽略 */ }
        const theme = ref(savedTheme);

        const isAppLoading = ref(true); // 应用首屏加载状态（数据就绪后淡出）

        // ================= [ 全局 Toast 消息通知系统 ] =================
        const toasts = ref([]);
        let toastIdCounter = 0;

        /**
         * 显示全局 Toast 消息（右上角自动淡入淡出，非阻塞）
         * @param {string} message - 消息内容
         * @param {string} type - 消息类型: 'success' | 'error' | 'info'
         * @param {number} duration - 显示时长(毫秒)，默认 3000
         */
        const showToast = (message, type = 'success', duration = 3000) => {
            const id = toastIdCounter++;
            toasts.value.push({ id, message, type });
            // 定时自动移除
            setTimeout(() => {
                const index = toasts.value.findIndex(t => t.id === id);
                if (index !== -1) toasts.value.splice(index, 1);
            }, duration);
        };

        // 🦾 排序数据状态提示：切换日期类排序时，若当前库该排序键无法区分卡片
        //    （全部缺失或全部相同，如库卡无 create_date / 大批同批导入文件时间一致），
        //    明确提示原因——否则用户会误以为「排序没反应」（其实已按名称稳定排序兜底）。
        const notifySortDataStatus = (mode) => {
            try {
                const cards = filteredLibrary.value || [];
                if (cards.length < 2) return;
                let keyFn = null;
                let label = '';
                let reason = '';
                if (mode === 'mtime') { keyFn = (c) => Number(c._mtime) || 0; label = '修改时间'; reason = '当前卡片文件修改时间缺失或相同'; }
                else if (mode === 'ctime') { keyFn = (c) => Number(c._ctime) || 0; label = '创建时间'; reason = '当前卡片文件创建时间缺失或相同（多为同一批导入）'; }
                else if (mode === 'importTime') { keyFn = (c) => Number(c._importTime) || Number(c._ctime) || 0; label = '导入最新'; reason = '当前卡片导入时间缺失或相同'; }
                else if (mode === 'sizeDesc' || mode === 'sizeAsc') { keyFn = (c) => Number(c._size) || 0; label = '大小'; reason = '当前卡片文件大小缺失或相同'; }
                else if (mode === 'time') { keyFn = (c) => Math.max(Number(c._mtime) || 0, Number(c._ctime) || 0); label = '本地文件最新'; reason = '当前卡片文件时间缺失或相同'; }
                else return; // name / nameDesc 总有差异，无需提示
                const set = new Set();
                cards.forEach(c => { try { set.add(keyFn(c)); } catch (e) { set.add(0); } });
                if (set.size <= 1) {
                    showToast(`「${label}」排序：${reason}，已按名称稳定排序`, 'info', 6000);
                }
            } catch (e) { /* 忽略 */ }
        };

        // 🔧 每次批量操作创建独立进度 Toast 句柄（并发安全，不再共享单例）
        const createProgressToast = () => {
            const id = toastIdCounter++;
            toasts.value.push({ id, message: '...', type: 'info' });
            const update = (msg) => {
                const t = toasts.value.find(x => x.id === id);
                if (t) t.message = msg;
            };
            const finish = (msg, type = 'success', duration = 3000) => {
                const t = toasts.value.find(x => x.id === id);
                if (t) { t.message = msg; t.type = type; }
                setTimeout(() => {
                    const i = toasts.value.findIndex(x => x.id === id);
                    if (i !== -1) toasts.value.splice(i, 1);
                }, duration);
            };
            return { update, finish };
        };

        // =========================================================
        // 🖥️ 智能屏幕分辨率与 Windows DPI 缩放适配（防双重放大）
        // （仅对首次启动/无存档用户生效，已有存档的用户尊重其手动设置）
        // =========================================================

        // 1. 获取 DPR（设备像素比，例如 150% 缩放时 dpr 为 1.5）
        const dpr = window.devicePixelRatio || 1;

        // 2. 获取【逻辑宽度】（已被操作系统除以 DPR 的宽度，缩放交给系统负责）
        // 例如：4K 屏 (3840) 开 200% 缩放后，logicalWidth 会是 1920
        const logicalWidth = window.innerWidth || window.screen.width || 1920;

        console.debug(`[DPI] dpr=${dpr}, logicalWidth=${logicalWidth}`);

        let defaultUiFs = 13;   // 界面字号（顶部导航/侧边栏/菜单/弹窗）
        let defaultWsFs = 14;   // 工作区字号（右侧编辑区：世界书/设定/聊天气泡/RAW JSON）

        // 3. 根据「真正的可用逻辑空间」来分配字号，完美避开双重放大
        if (logicalWidth >= 2560) {
            // 只有在实体大于 4K 且缩放比例很小，或者实体是 5K/8K 时，才会进入这里
            // 此时屏幕空间极度宽广，我们才主动调大字号
            defaultUiFs = 15;
            defaultWsFs = 16;
        } else if (logicalWidth >= 1600) {
            // 涵盖标准 1080p，或是 4K 开了 200%~225% 缩放的状态
            // 让 Windows 自己做缩放，我们保持标准字号！
            defaultUiFs = 13;
            defaultWsFs = 14;
        } else {
            // 小笔记本屏幕，或 1080p 开了 150% 缩放 (逻辑宽度约 1280)
            // 稍微缩小基础字号，避免界面被挤爆
            defaultUiFs = 12;
            defaultWsFs = 13;
        }

        // 4. 从 localStorage 读取历史设置，如果没有则使用智能默认值（防御性读取，localStorage 不可用时回退默认）
        const appSettings = ref((() => {
            const defaults = {
                // 注：内部用单引号，与设置面板下拉选项的值保持一致，确保初始选中项正确
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif",
                fontSize: defaultWsFs,      // 智能分配的工作区字号
                fontWeight: 'normal',       // 可选 'normal' 或 '500' (中等加粗)
                uiFontSize: defaultUiFs     // 智能分配的界面字号
            };
            let loadedSettings = defaults;
            try {
                const saved = JSON.parse(localStorage.getItem('appSettings'));
                if (saved) {
                    // 【修复】必须解构合并，让 defaults 兜底缺失字段
                    // （旧版本存档可能没有 fontFamily/fontWeight 等新字段，直接整体覆盖会变 undefined 导致样式错乱）
                    loadedSettings = { ...defaults, ...saved };
                }
            } catch (e) { /* 忽略 */ }
            // 兼容旧存档：缺失双轨字号时补智能默认值
            if (loadedSettings.uiFontSize === undefined) loadedSettings.uiFontSize = defaultUiFs;
            if (loadedSettings.fontSize === undefined) loadedSettings.fontSize = defaultWsFs;
            return loadedSettings;
        })());

        // 监听设置变化，自动保存到本地
        watch(appSettings, (newVal) => {
            try { localStorage.setItem('appSettings', JSON.stringify(newVal)); } catch (e) { /* 忽略 */ }
        }, { deep: true });

        // ================= [ 导入数据清洗开关 ] =================
        // 开启后，导入/扫描卡片时将忽略卡片自带的原生 tags（防止他人卡片的杂乱标签混入全局标签池），
        // 仅保留自动分类结果；分类统一由自动规则或用户手动指定。
        const sanitizeImportedTags = ref((() => {
            try { return localStorage.getItem('jsTavern_sanitizeImportedTags') === '1'; } catch (e) { return false; }
        })());
        watch(sanitizeImportedTags, (v) => {
            try { localStorage.setItem('jsTavern_sanitizeImportedTags', v ? '1' : '0'); } catch (e) { /* 忽略 */ }
        });

        

        // 字体设置应用：fontFamily/fontWeight 全局生效于 body；
        // 双轨字号：--ui-fs 接管外围界面（导航/侧边栏/菜单/弹窗），--workspace-fs 接管右侧工作区
        // （Vue 不会编译挂载容器 #app 自身的 :style 绑定，故此处以 documentElement 兜底保证变量生效）
        watch(appSettings, (s) => {
            document.body.style.fontFamily = s.fontFamily;
            document.body.style.fontWeight = s.fontWeight;
            document.documentElement.style.setProperty('--ui-fs', (s.uiFontSize || 13) + 'px');
            document.documentElement.style.setProperty('--workspace-fs', (s.fontSize || 14) + 'px');
        }, { deep: true, immediate: true });

        // ================= [ 实验功能与酒馆联动 ] =================
        const showExperimentalMenu = ref(false); // 控制实验菜单的展开/收起

        // 给设置里加一个酒馆API地址的配置项 (兼容旧设置)
        if (appSettings.value.tavernUrl === undefined) {
            appSettings.value.tavernUrl = 'http://127.0.0.1:8000';
        }
        // 酒馆本地根目录（物理推送用；绑定一次即可永久免密一键推送）
        if (appSettings.value.tavernLocalPath === undefined) {
            appSettings.value.tavernLocalPath = '';
        }
        if (appSettings.value.pushTargetMode === undefined) {
            appSettings.value.pushTargetMode = 'sillytavern';
        }
        if (appSettings.value.customPushPath === undefined) {
            appSettings.value.customPushPath = '';
        }
        if (appSettings.value.customPushName === undefined) {
            appSettings.value.customPushName = '';
        }
        if (!Array.isArray(appSettings.value.customPushTargets)) {
            appSettings.value.customPushTargets = [];
        }
        if (appSettings.value.currentPushTargetId === undefined) {
            appSettings.value.currentPushTargetId = '';
        }

        const makePushTargetId = () => 'push_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        const ensureCustomPushTargets = () => {
            if (!Array.isArray(appSettings.value.customPushTargets)) appSettings.value.customPushTargets = [];
            return appSettings.value.customPushTargets;
        };
        const getFolderDisplayName = (folderPath) => folderPath.split(/[\\/]/).filter(Boolean).pop() || '自定义卡库';
        const syncLegacyCustomPushFields = () => {
            const current = ensureCustomPushTargets().find(t => t.id === appSettings.value.currentPushTargetId) || null;
            appSettings.value.customPushPath = current?.path || '';
            appSettings.value.customPushName = current?.name || '';
        };
        const legacyCustomPath = (appSettings.value.customPushPath || '').trim();
        if (legacyCustomPath && !ensureCustomPushTargets().some(t => String(t.path || '').toLowerCase() === legacyCustomPath.toLowerCase())) {
            ensureCustomPushTargets().push({
                id: makePushTargetId(),
                name: (appSettings.value.customPushName || '').trim() || getFolderDisplayName(legacyCustomPath),
                path: legacyCustomPath
            });
        }

        const customPushTargets = computed(() => (
            ensureCustomPushTargets()
                .filter(t => t && typeof t.path === 'string' && t.path.trim() !== '')
                .map(t => ({
                    id: String(t.id || ''),
                    name: String(t.name || '').trim() || getFolderDisplayName(String(t.path || '')),
                    path: String(t.path || '').trim()
                }))
        ));
        const currentCustomPushTarget = computed(() => (
            customPushTargets.value.find(t => t.id === appSettings.value.currentPushTargetId)
            || customPushTargets.value[0]
            || null
        ));
        watch(customPushTargets, (targets) => {
            if (targets.length === 0) {
                appSettings.value.currentPushTargetId = '';
                appSettings.value.customPushPath = '';
                appSettings.value.customPushName = '';
                if (appSettings.value.pushTargetMode === 'custom') appSettings.value.pushTargetMode = 'sillytavern';
                return;
            }
            if (!targets.some(t => t.id === appSettings.value.currentPushTargetId)) {
                appSettings.value.currentPushTargetId = targets[0].id;
            }
            syncLegacyCustomPushFields();
        }, { deep: true, immediate: true });

        const currentPushTargetName = computed(() => (
            appSettings.value.pushTargetMode === 'custom'
                ? (currentCustomPushTarget.value?.name || '自定义卡库')
                : 'SillyTavern'
        ));

        const currentPushTargetHint = computed(() => (
            appSettings.value.pushTargetMode === 'custom'
                ? (currentCustomPushTarget.value?.path || '未绑定自定义卡库目录')
                : (appSettings.value.tavernLocalPath || '未绑定 SillyTavern 根目录')
        ));

        const rebindTavernPath = async (silent = false) => {
            const folderPath = await window.electronAPI.selectGenericFolder();
            if (!folderPath) return false;
            appSettings.value.tavernLocalPath = folderPath;
            appSettings.value.pushTargetMode = 'sillytavern';
            if (!silent) nativeAlert('推送目标已绑定为 SillyTavern：' + folderPath, 'info');
            return true;
        };

        const setCurrentCustomPushTarget = (targetId) => {
            if (!customPushTargets.value.some(t => t.id === targetId)) return false;
            appSettings.value.currentPushTargetId = targetId;
            appSettings.value.pushTargetMode = 'custom';
            syncLegacyCustomPushFields();
            return true;
        };

        const addCustomPushTarget = async (silent = false) => {
            if (!window.electronAPI || typeof window.electronAPI.selectPushFolder !== 'function') {
                nativeAlert('当前版本不支持自定义卡库推送，请更新应用。', 'warning');
                return false;
            }
            const folderPath = await window.electronAPI.selectPushFolder();
            if (!folderPath) return false;
            const folderName = getFolderDisplayName(folderPath);
            const existing = ensureCustomPushTargets().find(t => String(t.path || '').toLowerCase() === folderPath.toLowerCase());
            const defaultName = existing?.name || appSettings.value.customPushName || folderName;
            const customName = await appPrompt('给这个自定义卡库起个名字：', defaultName);
            if (customName === null) return false;
            const finalName = (customName || '').trim() || folderName;
            if (existing) {
                existing.name = finalName;
                existing.path = folderPath;
                appSettings.value.currentPushTargetId = existing.id;
            } else {
                const target = { id: makePushTargetId(), name: finalName, path: folderPath };
                ensureCustomPushTargets().push(target);
                appSettings.value.currentPushTargetId = target.id;
            }
            appSettings.value.pushTargetMode = 'custom';
            syncLegacyCustomPushFields();
            if (!silent) nativeAlert(`已保存卡库目标【${finalName}】\n${folderPath}`, 'info');
            return true;
        };

        const renameCurrentCustomPushTarget = async () => {
            const current = currentCustomPushTarget.value;
            if (!current) return false;
            const nextName = await appPrompt('修改当前卡库目标名称：', current.name);
            if (nextName === null) return false;
            const matched = ensureCustomPushTargets().find(t => t.id === current.id);
            if (!matched) return false;
            matched.name = (nextName || '').trim() || getFolderDisplayName(matched.path || current.path || '');
            syncLegacyCustomPushFields();
            showToast(`已重命名为 ${matched.name}`, 'success');
            return true;
        };

        const removeCurrentCustomPushTarget = async () => {
            const current = currentCustomPushTarget.value;
            if (!current) return false;
            const ok = await confirmDialog(`确定删除卡库目标【${current.name}】吗？\n只会删除保存的快捷目标，不会删除真实文件夹。`);
            if (!ok) return false;
            const nextTargets = ensureCustomPushTargets().filter(t => t.id !== current.id);
            appSettings.value.customPushTargets = nextTargets;
            if (nextTargets.length > 0) {
                appSettings.value.currentPushTargetId = nextTargets[0].id;
                appSettings.value.pushTargetMode = 'custom';
            } else {
                appSettings.value.currentPushTargetId = '';
                appSettings.value.pushTargetMode = 'sillytavern';
            }
            syncLegacyCustomPushFields();
            showToast(`已删除目标 ${current.name}`, 'success');
            return true;
        };

        const useSillyTavernPushTarget = async () => {
            if (appSettings.value.pushTargetMode !== 'sillytavern' && appSettings.value.tavernLocalPath) {
                appSettings.value.pushTargetMode = 'sillytavern';
                showToast('已切换到 SillyTavern 推送目标', 'success');
                return true;
            }
            return await rebindTavernPath();
        };

        const useCustomPushTarget = async () => {
            if (appSettings.value.pushTargetMode !== 'custom' && customPushTargets.value.length > 0) {
                appSettings.value.pushTargetMode = 'custom';
                if (!appSettings.value.currentPushTargetId) appSettings.value.currentPushTargetId = customPushTargets.value[0].id;
                syncLegacyCustomPushFields();
                showToast(`已切换到 ${currentPushTargetName.value}`, 'success');
                return true;
            }
            return await addCustomPushTarget();
        };

        const pushCardPathsToCurrentTarget = async (pathsToPush, options = {}) => {
            const { clearAfter = false, sourceName = '角色卡' } = options;
            const validPaths = Array.isArray(pathsToPush) ? pathsToPush.filter(Boolean) : [];
            if (validPaths.length === 0) {
                return nativeAlert(`未找到可推送的${sourceName}物理文件路径。`, 'warning');
            }

            try {
                if (appSettings.value.pushTargetMode === 'custom') {
                    let targetDir = currentCustomPushTarget.value?.path || '';
                    if (!targetDir) {
                        const ok = await confirmDialog('当前未绑定自定义卡库目录，是否现在选择？');
                        if (!ok) return;
                        const bound = await addCustomPushTarget(true);
                        if (!bound) return;
                        targetDir = currentCustomPushTarget.value?.path || '';
                    }

                    const res = await window.electronAPI.pushToCustomDir(validPaths, targetDir);
                    if (res && res.success) {
                        nativeAlert(
                            `🎉 推送完成！共 ${res.count} 张${sourceName}已发送到【${currentPushTargetName.value}】！` +
                            ((res.overwritten && res.overwritten.length > 0)
                                ? `\n其中 ${res.overwritten.length} 张同名卡已更新，旧版已存入回收站。` : '') +
                            `\n目标目录：${targetDir}`, 'info');
                        if (clearAfter) clearSelection();
                    } else {
                        if (res && res.error === '路径越界，操作被拒绝') {
                            syncLegacyCustomPushFields();
                            const reBind = await confirmDialog('目标卡库目录不在授权范围内（可能应用已重启或目录已变更）。\n是否重新选择该目录？');
                            if (reBind) {
                                const bound = await addCustomPushTarget(true);
                                if (bound) {
                                    showToast(`已重新绑定 ${currentPushTargetName.value}，正在重试推送…`, 'info');
                                    return await pushCardPathsToCurrentTarget(validPaths, options);
                                }
                            }
                        }
                        nativeAlert(`推送失败：${(res && res.error) || '未知错误'}\n请重新确认自定义卡库目录。`, 'error');
                    }
                    return;
                }

                let stRoot = appSettings.value.tavernLocalPath;
                if (!stRoot) {
                    const autoDetected = await window.electronAPI.autoDetectTavernPath();
                    if (autoDetected) {
                        const confirmAuto = await confirmDialog(`🎉 系统自动检测到了你的酒馆路径：\n\n${autoDetected}\n\n是否直接使用该路径？(选确定将自动永久绑定)`);
                        if (confirmAuto) {
                            stRoot = autoDetected;
                            appSettings.value.tavernLocalPath = stRoot;
                            appSettings.value.pushTargetMode = 'sillytavern';
                        }
                    }
                }

                if (!stRoot) {
                    const confirmManual = await confirmDialog('尚未绑定 SillyTavern 本地目录，且未自动检索到。\n是否现在手动选择你的酒馆【根文件夹】？\n(选对一次即可永久免密一键推送)');
                    if (!confirmManual) return;
                    const bound = await rebindTavernPath(true);
                    if (!bound) return;
                    stRoot = appSettings.value.tavernLocalPath;
                }

                const res = await window.electronAPI.pushToSillyTavernDir(validPaths, stRoot);
                if (res && res.success) {
                    nativeAlert(
                        `🎉 推送完成！共 ${res.count} 张${sourceName}已发送至酒馆！` +
                        ((res.overwritten && res.overwritten.length > 0)
                            ? `\n其中 ${res.overwritten.length} 张同名卡已更新，旧版已存入回收站。` : '') +
                        `\n请前往酒馆刷新角色列表查看。`, 'info');
                    if (clearAfter) clearSelection();
                } else {
                    appSettings.value.tavernLocalPath = '';
                    nativeAlert(`推送失败：${(res && res.error) || '未知错误'}\n目录绑定已自动重置，请下次重新选择正确的 SillyTavern 根目录。`, 'error');
                }
            } catch (error) {
                nativeAlert(`推送发生底层异常: ${error.message}`, 'error');
            }
        };

        // 🚀 当前打开的卡片（未勾选任何卡片时，作为推送兜底对象）
        const currentOpenCardItem = computed(() => {
            if (!cardData.value) return null;
            return library.value.find(item => item.data === cardData.value) || null;
        });

        const pushToTavern = async () => {
            showExperimentalMenu.value = false;

            let pathsToPush;
            if (selectedIds.value.length > 0) {
                // 有勾选 → 推送全部勾选卡片
                pathsToPush = library.value
                    .filter(c => selectedIds.value.includes(c.id))
                    .map(c => c.path)
                    .filter(Boolean);
            } else if (currentOpenCardItem.value && currentOpenCardItem.value.path) {
                // 未勾选 → 回退推送当前打开的卡片
                pathsToPush = [currentOpenCardItem.value.path];
            }

            if (!pathsToPush || pathsToPush.length === 0) {
                return nativeAlert('请先勾选要推送的角色卡，或先打开一张卡片！', 'warning');
            }

            return await pushCardPathsToCurrentTarget(pathsToPush, { clearAfter: true, sourceName: '角色卡' });
        };

        // ================= [ 顶部菜单系统：视图选项与工具函数 ] =================
        // API 设置独立弹窗开关
        const showApiModal = ref(false);
        // 🚀 推送目标选择对话框开关（顶部「推送(P)」菜单打开）
        const showPushModal = ref(false);
        // 视图菜单控制状态（控制 Raw JSON 页签 / 立绘预览 / Token 分析栏的显隐）
        const viewOptions = ref({
            showSidebar: true,        // 左侧侧边栏（角色卡列表）
            showToolbar: true,        // 顶部快捷工具栏
            showRawJson: true,        // 是否显示 Raw JSON 页签
            showAvatarPreview: true,  // 是否显示顶部立绘预览
            showTokenStats: true,     // 是否显示 Token 消耗分析栏
            showWorldbook: true,      // 是否显示世界书页签
            showRegex: true           // 是否显示正则脚本页签
        });

        // 导入单张/多张角色卡文件（经隐藏文件输入，追加写入当前库）
        const importFileInput = ref(null);
        const handleImportFiles = async (e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = ''; // 允许重复选择同一文件
            let added = 0;
            let skippedExisting = 0;
            // 🚀 性能优化：批量导入推入 staging 暂存数组（每张卡不再触发全库 computed 失效 + 搜索索引全量重建），
            //    全部解析完成后一次性分批并入 library（每批 500），自动打标落盘转后台低并发执行。
            const staging = [];
            const seenPaths = new Set(); // 🚀 v2.0：批量导入 O(1) 去重

            // 🚀 v2.0 修复：第一阶段一次性收集全部真实路径并单次 copyToLibrary ——
            //    替代旧版循环内每文件一次 copyToLibrary（万张 = 万次 IPC + 万次同步拷贝阻塞主进程）。
            const realPaths = files.map(f => (window.electronAPI ? window.electronAPI.getPathForFile(f) : null));
            let copiedPaths = [];
            if (window.electronAPI && currentFolderPath.value && realPaths.some(p => p)) {
                const srcs = realPaths.filter(p => p);
                try {
                    copiedPaths = await window.electronAPI.copyToLibrary(srcs, currentFolderPath.value);
                } catch (copyErr) {
                    console.warn('批量复制到库目录失败', copyErr);
                    copiedPaths = [];
                }
            }
            // basename → dest 映射（按文件名回填最终库内路径）
            const copiedByBase = new Map();
            for (const p of copiedPaths) copiedByBase.set(String(p).split(/[\\/]/).pop(), p);

            for (let idx = 0; idx < files.length; idx++) {
                const f = files[idx];
                try {
                    // Electron 33 起 File.path 已移除，经 preload 获取真实绝对路径
                    const realPath = realPaths[idx];
                    const isImage = /\.(png|webp|jpe?g)$/i.test(f.name);
                    const isJson = /\.json$/i.test(f.name);

                    // 🛡️ 破碎图标修复：先把文件物理复制到当前库目录（与拖拽导入一致），
                    // 再用 local-file:// 永久路径做图片地址 → 重启后图片依然正常显示。
                    let finalPath = realPath || f.name;
                    let finalUrl = null;
                    let rawBuffer = null;
                    let rawText = null;

                    if (window.electronAPI && realPath && currentFolderPath.value) {
                        const dest = copiedByBase.get(f.name);
                        if (dest) {
                            finalPath = dest;
                            finalUrl = isImage ? 'local-file://img/?path=' + encodeURIComponent(dest) : null;
                        } else {
                            // 🔧 库内已有同名（或格式不支持被跳过）：计数并继续处理后续文件
                            skippedExisting++;
                            continue;
                        }
                    }

                    const file = {
                        name: f.name,
                        path: finalPath,
                        url: finalUrl
                    };

                    // 读取文件内容：优先从复制后的库内文件读取（白名单内，IPC 可靠）；
                    // 复制失败/无库目录时回退浏览器 File API（绕过白名单，保证能导入）
                    if (isImage) {
                        try {
                            if (window.electronAPI && finalPath !== (realPath || f.name)) {
                                const res = await window.electronAPI.readBuffer(finalPath);
                                if (res && typeof res === 'object' && res.buffer) {
                                    rawBuffer = res.buffer;
                                }
                            }
                        } catch (err) { /* 忽略 */ }
                        if (!rawBuffer) {
                            try { rawBuffer = await f.arrayBuffer(); } catch (readErr) { console.warn(`读取图片内容失败 ${f.name}:`, readErr); }
                        }
                        file.rawBuffer = rawBuffer;
                    } else if (isJson) {
                        try {
                            if (window.electronAPI && finalPath !== (realPath || f.name)) {
                                const res = await window.electronAPI.readText(finalPath);
                                if (res?.success && typeof res.text === 'string') rawText = res.text;
                            }
                        } catch (err) { /* 忽略 */ }
                        if (rawText === null || rawText === undefined) {
                            try { rawText = await f.text(); } catch (readErr) { console.warn(`读取 JSON 内容失败 ${f.name}:`, readErr); }
                        }
                        file.rawText = rawText;
                    }

                    // 🛡️ 兜底：若 Electron 环境无法用 local-file 协议展示（无库目录时），
                    // 用 blob URL 保证本次会话内能看到图（重启后由用户重新导入解决）
                    if (!file.url && isImage) {
                        file.url = URL.createObjectURL(f);
                    }

                    if (await parseAndAddCard(file, { target: staging, deferAutoTagSave: true, seenPaths })) added++;
                    else if (file._skippedExisting) skippedExisting++;
                    else {
                        // 🔧 解析失败时回收兜底 blob URL（此时无人接管该 URL，
                        // 批量导入失败场景下大图 blob 会持续占用内存）
                        if (file.url && file.url.startsWith('blob:')) URL.revokeObjectURL(file.url);
                        console.warn(`未能解析为角色卡: ${f.name}（rawBuffer=${file.rawBuffer ? '有' : '无'}, path=${file.path}）`);
                    }
                } catch (err) {
                    console.warn(`导入失败 ${f.name}`, err);
                }
            }
            // 🚀 一次性分批并入 library（shallowRef 下 push 不触发响应式，最后统一 triggerRef）
            for (let i = 0; i < staging.length; i += 500) {
                library.value.push(...staging.slice(i, i + 500));
            }
            triggerRef(library); // shallowRef：手动通知 Vue 列表已变更
            // 🚀 自动打标物理落盘转后台低并发执行（避免逐卡写盘 I/O 风暴卡死 UI）
            if (staging.length > 0 && typeof flushDeferredAutoTagSaves === 'function') {
                flushDeferredAutoTagSaves();
            }
            if (added > 0) {
                let msg = `成功导入 ${added} 张角色卡！`;
                if (skippedExisting > 0) msg += `\n${skippedExisting} 张已在库中，已跳过。`;
                nativeAlert(msg, 'info');
            } else if (skippedExisting > 0) {
                nativeAlert(`所选文件已在库中（${skippedExisting} 张），未重复添加。\n若需导入新卡，请选择库中不存在的卡片文件。`, 'warning');
            } else {
                nativeAlert('未识别到有效的角色卡文件。', 'warning');
            }
        };
        // 📥 importCards（触发隐藏文件输入）已迁至 useCardCrud 组合式函数（见下文 setup 中部调用）

        // 全选当前过滤列表中的所有卡片（并自动进入多选模式）
        const selectAllCards = () => {
            if (!isMultiSelectMode.value) isMultiSelectMode.value = true;
            selectedIds.value = filteredLibrary.value.map(i => i.id);
            nativeAlert(`已全选 ${selectedIds.value.length} 张卡片。`, 'info');
        };

        // 清理全库所有卡片中的无效标签（空字符串/纯空白），并物理落盘
        const cleanGlobalTagsPrompt = async () => {
            const modifiedItems = [];
            library.value.forEach(item => {
                let isModified = false;
                const cleanArr = (arr) => arr.filter(t => t && String(t).trim() !== '');
                if (Array.isArray(item.customTags)) {
                    const filtered = cleanArr(item.customTags);
                    if (filtered.length !== item.customTags.length) { item.customTags = filtered; isModified = true; }
                }
                const d = item.data?.data || item.data || {};
                if (Array.isArray(d.tags)) {
                    const filtered = cleanArr(d.tags);
                    if (filtered.length !== d.tags.length) { d.tags = filtered; isModified = true; }
                }
                if (isModified) modifiedItems.push(item);
            });

            if (modifiedItems.length === 0) {
                return nativeAlert('库中未发现无效标签（空字符串等）。', 'info');
            }

            let saved = 0;
            for (const item of modifiedItems) {
                try {
                    // 统一持久化中枢：写覆盖层 + 物理落盘
                    await persistCardUpdate(item, { tags: item.customTags, category: item.category });
                    saved++;
                } catch (err) { console.error(`清理无效标签保存失败 [${item.name}]`, err); }
            }
            nativeAlert(`已清理 ${modifiedItems.length} 张卡片中的无效标签，并物理保存 ${saved} 张。`, 'info');
        };

        // 用系统资源管理器打开当前库的快照 / 回收站文件夹
        const openBakFolder = async () => {
            if (!currentFolderPath.value) return nativeAlert('请先打开角色库文件夹。', 'warning');
            const res = await window.electronAPI.openPath(currentFolderPath.value + '\\.bak_history');
            if (!res.success) nativeAlert(res.error || '打开失败', 'error');
        };
        const openTrashFolder = async () => {
            if (!currentFolderPath.value) return nativeAlert('请先打开角色库文件夹。', 'warning');
            const res = await window.electronAPI.openPath(currentFolderPath.value + '\\.trash');
            if (!res.success) nativeAlert(res.error || '打开失败', 'error');
        };
        // 打开全局回收站（世界书删除/查重清洗移入的 userData/jsTavern_Trash）
        const openGlobalTrash = async () => {
            if (!window.electronAPI || typeof window.electronAPI.openGlobalTrash !== 'function') {
                nativeAlert('当前环境不支持打开全局回收站。', 'warning');
                return;
            }
            const res = await window.electronAPI.openGlobalTrash();
            if (!res.success) nativeAlert(`打开全局回收站失败: ${res.error}`, 'error');
        };

        // 打开聊天测卡（映射到聊天 Tab）
        const openChatTab = () => { currentTab.value = 'chat'; initChat(); };

        const isDragging = ref(false);
        const dragCounter = ref(0); // 拖拽进入深度计数器（防止在子元素间移动时遮罩闪烁）

        // 拖拽进入窗口：深度 +1 并显示全屏遮罩
        const handleDragEnter = (e) => {
            e.preventDefault();
            dragCounter.value++;
            isDragging.value = true;
        };

        // 拖拽离开窗口：深度 -1，归零后才隐藏遮罩
        const handleDragLeave = (e) => {
            e.preventDefault();
            // 🔧 兜底修复：拖拽取消/拖出窗口时 relatedTarget 为 null，直接复位，
            // 杜绝计数器残留导致下次拖入时遮罩不再消失
            if (!e.relatedTarget) {
                dragCounter.value = 0;
                isDragging.value = false;
                return;
            }
            dragCounter.value = Math.max(0, dragCounter.value - 1);
            if (dragCounter.value === 0) isDragging.value = false;
        };
        const cardData = shallowRef(null); // 【优化】使用浅层响应式，完美解决大卡片切换卡顿
        const imgUrl = ref(null);
        const currentTab = ref('basic');
        const library = shallowRef([]); // 🚀 shallowRef：万卡库避免 Vue 深层 Proxy 化（数十万 Proxy → 内存爆炸/卡顿）
        // ================= 动态分类/分组与多语言系统 =================
        // 全量系统预设分组（中英文对照）
        const allDefaultCategories = [
            { key: 'all', cn: '全部', en: 'All' },
            { key: 'uncategorized', cn: '未分类', en: 'Uncategorized' },
            { key: 'fantasy', cn: '奇幻', en: 'Fantasy' },
            { key: 'scifi', cn: '科幻', en: 'Sci-Fi' },
            { key: 'romance', cn: '恋爱', en: 'Romance' },
            { key: 'nsfw', cn: '限制级', en: 'NSFW' }
        ];
        // 【修复】被用户删除/重命名的预设分组 key（localStorage 持久化，重启不再重新生成）
        const removedDefaultKeys = ref((() => {
            try {
                const saved = JSON.parse(localStorage.getItem('jsTavern_removedDefaultCategories'));
                if (Array.isArray(saved)) return saved.filter(k => typeof k === 'string');
            } catch (e) { /* 忽略 */ }
            return [];
        })());
        // 生效的系统预设分组（排除已被删除/重命名的，重启保持用户的选择）
        const defaultCategories = ref(allDefaultCategories.filter(c => !removedDefaultKeys.value.includes(c.key)));
        // 持久化删除/重命名记录（localStorage + 主进程配置文件）
        watch(removedDefaultKeys, (v) => {
            try { localStorage.setItem('jsTavern_removedDefaultCategories', JSON.stringify(v)); } catch (e) { /* 忽略 */ }
            saveUiSettingsToDisk();
        }, { deep: true });

        // 用户自定义添加的额外分组列表（存字符串；localStorage 持久化，重启不丢失）
        const customCategories = ref((() => {
            try {
                const saved = JSON.parse(localStorage.getItem('jsTavern_customCategories'));
                if (Array.isArray(saved)) return saved.filter(c => typeof c === 'string' && c.trim() !== '');
            } catch (e) { /* 忽略 */ }
            return [];
        })());

        // 监听分类列表变化，实时写入 localStorage + 主进程配置文件（新建/重命名/删除自动持久化）
        watch(customCategories, (newVal) => {
            try { localStorage.setItem('jsTavern_customCategories', JSON.stringify(newVal)); } catch (e) { /* 忽略 */ }
            saveUiSettingsToDisk();
        }, { deep: true });

        // 合并系统预设与自定义分组
        const allCategories = computed(() => {
            const customObjs = customCategories.value
                .filter(c => typeof c === 'string' && c.trim() !== '') // 🔧 兜底过滤空值，任何来源的空组都无法渲染
                .map(c => ({ key: c, cn: c, en: c }));
            return [...defaultCategories.value, ...customObjs];
        });

        // 判断名称是否已存在于预设或自定义分组（中/英/key 任一匹配即视为已知，避免与预设重复）
        const isCategoryKnown = (name) => allCategories.value.some(c => c.cn === name || c.en === name || c.key === name);

        // 根据当前语言模式（tagLangMode）渲染分类显示名称
        const getCategoryDisplayName = (catObj) => {
            if (tagLangMode.value === 'cn') return catObj.cn;
            if (tagLangMode.value === 'en') return catObj.en;
            return `${catObj.en} (${catObj.cn})`;
        };

        // 当前选中的分类 key
        const currentCategoryKey = ref('all');

        // 📁 分组操作（新建/删除/重命名）已拆分为组合式函数 useCardGroups（见下文 setup 尾部调用）

        // 📁 卡片分类映射与物理移动已拆分为组合式函数 useCardGroups（见下文 setup 尾部调用）

        // 📸 历史快照功能已拆分为组合式函数 useSnapshots（见下文 setup 尾部调用）

        // 分页状态
        const currentPage = ref(1);
        const itemsPerPage = ref(18);

        // 自动贴标签规则 autoTagRules 已迁至 utils/cardLoader.js（纯常量，随 import 引入）

        // 记录从外部导入的配置，格式: { '卡片原名': { category: 'xx', customTags: ['A', 'B'] } }
        const importedConfig = ref({});

        // 【修复】卡片分类实时持久化（localStorage，跨重启保留）
        // 分组重命名/删除/移动后同步写入；重扫/启动时优先于自动分类恢复。
        // 说明：category 是前端库字段（不在卡片文件 JSON 内），无法用 saveCard 落盘，
        // 因此用 localStorage 作为其持久化载体，与「导出/导入库配置」双保险。
        const localCategoryMap = ref((() => {
            try {
                const saved = JSON.parse(localStorage.getItem('jsTavern_cardsCategory'));
                if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved;
            } catch (e) { /* 忽略 */ }
            return {};
        })());
        watch(localCategoryMap, (v) => {
            try { localStorage.setItem('jsTavern_cardsCategory', JSON.stringify(v)); } catch (e) { /* 忽略 */ }
            saveUiSettingsToDisk();
        }, { deep: true });
        // persistCardCategory（单卡分类双保险持久化）已迁至 useCardCrud 组合式函数（见下文 setup 中部调用）

        // =========================================================
        // 🛡️ 统一持久化中枢（app_config.json 最高权威）
        // 全软件全局状态（语言/分组/全局标签池/卡片覆盖层/API Key）统一收口于此：
        //   - syncConfigToDisk()   全局配置原子落盘（从各 ref 收集 → 剥离 Proxy → 写盘）
        //   - persistCardUpdate()  卡片变更中枢（更新内存 + 写覆盖层 + 物理重写 PNG）
        // ⚠️ 生产模式 app:// 的 localStorage 不持久，app_config.json 才是跨重启权威载体。
        // =========================================================
        const appConfig = ref({
            language: 'zh-CN',
            tagLangMode: 'both',
            customCategories: [],
            removedDefaultKeys: [],
            globalTags: [],       // 全局/常用标签池
            cardOverlays: {},     // 卡片属性物理覆盖表 { "卡片路径|名称": { category, tags } }
            api: {                // API 配置（生产 app:// 下 localStorage 不持久，统一走物理文件）
                endpoint: '',
                key: '',
                model: '',
                type: 'openai'
            }
        });
        // 📥 卡片导入时间映射 { [path]: timestampMs }（「导入时间」排序持久化；首次入库时刻记录）
        const cardImportTimes = ref({});
        const snapshotConfig = ref((() => {
            const defaults = { enabled: true, intervalMinutes: 5, maxSnapshots: 10 };
            try {
                return {
                    enabled: localStorage.getItem('snapshot_enabled') !== 'false',
                    intervalMinutes: Number(localStorage.getItem('snapshot_interval')) || defaults.intervalMinutes,
                    maxSnapshots: Number(localStorage.getItem('snapshot_max_count')) || defaults.maxSnapshots
                };
            } catch (e) { return { ...defaults }; }
        })());

        const currentFolderPath = ref(''); // 当前打开的文件夹路径（Electron）

        // ================= [ 多选与批量操作状态 ] =================
        const selectedIds = ref([]); // 存放被选中的卡片 ID
        const lastSelectedIndex = ref(-1); // 用于 Shift 连续多选记录

        // 🧹 清除多选（共享工具：被 useBatch/useCardGroups/useTags 注入）
        const clearSelection = () => {
            selectedIds.value = [];
            lastSelectedIndex.value = -1;
        };

        // ================= [ 聊天测卡状态 ] =================
        // 默认地址：兼容 LM Studio 或 Oobabooga 的 OpenAI 格式接口（支持持久化，重启后自动恢复）
        const DEFAULT_API_ENDPOINT = 'http://127.0.0.1:1234/v1/chat/completions';
        let savedEndpoint = '';
        try { savedEndpoint = localStorage.getItem('stc-api-endpoint') || ''; } catch (e) { /* 忽略 */ }
        const apiEndpoint = ref(savedEndpoint || DEFAULT_API_ENDPOINT);

        // API 鉴权密钥（可配置，远端 API 需要真实 key；本地 API 可留空，主进程回退到 test-key）
        let savedApiKey = '';
        try { savedApiKey = localStorage.getItem('stc-api-key') || ''; } catch (e) { /* 忽略 */ }
        const apiKey = ref(savedApiKey);
        // 🔐 解密历史密文（代码审查修复 2）：兼容旧明文——解密失败则原样使用
        if (savedApiKey && window.electronAPI && typeof window.electronAPI.decryptSecret === 'function') {
            (async () => {
                try {
                    const dec = await window.electronAPI.decryptSecret(savedApiKey);
                    if (dec && dec.success && typeof dec.value === 'string') apiKey.value = dec.value;
                } catch (e) { /* 解密失败回退明文 */ }
            })();
        }

        // API 模型名称（OpenAI 兼容格式的 model 字段；本地 LM Studio/Ollama 通常忽略，可留空回退 local-model）
        let savedApiModel = '';
        try { savedApiModel = localStorage.getItem('stc-api-model') || ''; } catch (e) { /* 忽略 */ }
        const apiModel = ref(savedApiModel);

        // 生成 API 请求的 model 字段：优先使用配置的模型名称，留空时按协议回退
        // 【修复】Anthropic 协议必须回退到 Claude 模型，否则网关返回 400；OpenAI 兼容协议才用 local-model
        const resolveApiModel = () => {
            if (apiModel.value && apiModel.value.trim()) return apiModel.value.trim();
            return apiType.value === 'anthropic' ? 'claude-3-haiku-20240307' : 'local-model';
        };

        // API 三件套（Endpoint / Key / Model）变化时自动持久化：localStorage 兜底 + 统一配置中枢（app_config.json）
        watch(apiEndpoint, (v) => {
            try { localStorage.setItem('stc-api-endpoint', v || ''); } catch (e) { /* 忽略 */ }
            syncConfigToDisk();
        });
        watch(apiKey, async (v) => {
            // 🔐 落盘前加密（代码审查修复 2）：密文写入 localStorage，明文只存内存
            let storeVal = v || '';
            if (storeVal && window.electronAPI && typeof window.electronAPI.encryptSecret === 'function') {
                try {
                    const enc = await window.electronAPI.encryptSecret(storeVal);
                    if (enc && enc.success && enc.value) storeVal = enc.value;
                } catch (e) { /* 加密失败回退明文 */ }
            }
            try { localStorage.setItem('stc-api-key', storeVal); } catch (e) { /* 忽略 */ }
            syncConfigToDisk();
        });
        watch(apiModel, (v) => {
            try { localStorage.setItem('stc-api-model', v || ''); } catch (e) { /* 忽略 */ }
            syncConfigToDisk();
        });

        // API 协议类型：'openai'（OpenAI 兼容，默认）或 'anthropic'（Claude 原生）
        let savedApiType = '';
        try { savedApiType = localStorage.getItem('stc-api-type') || ''; } catch (e) { /* 忽略 */ }
        const apiType = ref(savedApiType === 'anthropic' ? 'anthropic' : 'openai');
        watch(apiType, (v) => {
            try { localStorage.setItem('stc-api-type', v || 'openai'); } catch (e) { /* 忽略 */ }
            syncConfigToDisk();
        });

        // ✨ 聊天测卡逻辑（sendMessage/initChat/clearChat）与 API 设置保存/切换 已拆分为组合式函数 useChat（见下文 setup 尾部调用）
        // ✅ [补丁] 引擎协议切换时强制清洗不兼容的模型名，防止把 local-model/gpt-* 发给 Claude 触发 400
        watch(apiType, (newType) => {
            const currentModel = (apiModel.value || '').trim();
            // 切到 Claude：本地/OpenAI 系模型名与 Anthropic 不兼容，强制清空触发默认回退（claude-3-haiku）
            if (newType === 'anthropic' && (currentModel === 'local-model' || currentModel.startsWith('gpt-'))) {
                apiModel.value = '';
            }
            // 切回 OpenAI 兼容：清除 Claude 系模型名
            else if (newType !== 'anthropic' && currentModel.startsWith('claude-')) {
                apiModel.value = 'local-model';
            }
        });

        // 兼容 OpenAI（choices[0].message.content）与 Anthropic（content[0].text）的回复提取
        const extractReplyContent = (result) => {
            if (!result || !result.data) return '';
            const d = result.data;
            if (apiType.value === 'anthropic') {
                return (d.content && d.content[0] && d.content[0].text) || '';
            }
            return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
        };

        // ================= [ API 模型列表拉取（GET /v1/models，经主进程转发绕过 CORS）] =================
        // （已拆分为组合式函数 useChat）

        // 兼容不同数据结构的取值助手：优先取 data 字段
        const safeData = computed(() => {
            if (!cardData.value) return {};
            return cardData.value.data || cardData.value || {};
        });

        // 【修复】shallowRef 下深层编辑（v-model 直接改 data 内部字段）不会触发响应式更新，
        // 导致 Token 统计 / Raw JSON 视图在打字时不刷新。手动 triggerRef 强制刷新（保留 shallowRef 性能优势）
        const refreshCardData = () => {
            if (cardData.value) triggerRef(cardData);
            // 🚀 v1.8.5：编辑器改了当前卡内容 → 精确失效该卡的 Token 缓存（侧栏徽章下次渲染重算）
            if (cardData.value) cardTokensCache.delete(cardData.value);
        };

        // 识别卡片规范版本
        const specVersion = computed(() => {
            if (!cardData.value) return 'Unknown';
            if (cardData.value.spec === 'chara_card_v3') return 'V3';
            if (cardData.value.spec === 'chara_card_v2') return 'V2';
            if (cardData.value.name && !cardData.value.data) return 'V1 / Custom';
            return 'Custom';
        });

        // 🌍 角色卡内嵌世界书编辑域（worldbookEntries / getEntryUid / worldbookExpanded /
        //    toggle·expand·collapse / getKeysString / updateEntryKeys）
        //    已迁至 useEmbeddedWorldbook 组合式函数（见下文 setup 中部调用）

        // 正则脚本稳定标识（同世界书机制，避免增删时节点错位）
        // 【修复】同样改用 WeakMap，避免正则脚本对象被丢弃后残留强引用
        const regexUidMap = new WeakMap();
        let regexUidCounter = 0;
        const getRegexUid = (script) => {
            if (!script || typeof script !== 'object') return 'regex-' + (++regexUidCounter);
            if (!regexUidMap.has(script)) regexUidMap.set(script, 'regex-' + (++regexUidCounter));
            return regexUidMap.get(script);
        };

        // 【修复】富文本渲染与代码安全转义
        const renderHTML = (text) => {
            if (!text) return '';
            // 1. 必须先转义 < 和 >，否则 <html> 这种代码会被浏览器吞掉
            let safeText = text.replace(/&/g, "&amp;")
                               .replace(/</g, "&lt;")
                               .replace(/>/g, "&gt;");
            // 2. 替换换行，保留多个空格以便代码缩进不丢失
            return safeText.replace(/\n/g, '<br>')
                           .replace(/\s\s/g, '&nbsp;&nbsp;');
        };

        // 【安全加固】渲染模式专用：允许基本排版标签，但剥离脚本/事件/危险协议
        // 经 DOMPurify 清洗后再 v-html，从源头掐断聊天内容 XSS（追踪像素/内网探测/脚本注入）
        const renderSafeHTML = (text) => {
            if (!text) return '';
            return DOMPurify.sanitize(text, {
                ALLOWED_TAGS: [
                    'b', 'i', 'em', 'strong', 'u', 's', 'br', 'p', 'div', 'span',
                    'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'img', 'hr',
                    'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'td', 'th'
                ],
                ALLOWED_ATTR: ['class', 'style', 'src', 'alt', 'title'],
                ALLOW_DATA_ATTR: false,
                // 【安全修复】FORBID_ATTR 只接受属性名字符串（内部哈希查找，不支持正则），
                // 显式列出常见事件属性（真正生效的兜底写法）；ALLOWED_ATTR 白名单仍是主防线
                FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'oninput', 'onanimationstart', 'onanimationend', 'onpointerdown', 'onpointerup', 'onpointermove', 'ondragstart', 'ondrop'],
                // 【安全平衡】允许内嵌 base64 图(data:image/)与相对路径，禁止 http(s) 外联
                // （防追踪像素/内网探测；外联图需求可再评估放开）
                ALLOWED_URI_REGEXP: /^(?:data:image\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
            });
        };

        // 【修复】清洗 Markdown 代码块标记（```html、```yaml、```json 等），
        // 防止渲染模式下这些围栏标记被当成普通文本暴露在气泡顶部/底部
        const cleanMarkdownFences = (text) => {
            if (!text) return '';
            return text
                .replace(/```[a-zA-Z]*\n?/gi, '') // 【修复】匹配任意语言标记 (```python、```markdown、``` 等)，不再残留裸文本
                .replace(/```/g, ''); // 洗掉结尾的 ```
        };

        // 正则脚本（兼容不同存放位置；只读提取，不做副作用，避免无正则卡片保存时写入空数组）
        const regexScripts = computed(() => {
            const d = safeData.value;
            if (!d || typeof d !== 'object') return [];
            return d.extensions?.regex_scripts || (Array.isArray(d.regex_scripts) ? d.regex_scripts : []);
        });

        // 确保 extensions.regex_scripts 数组存在（仅在用户主动编辑/新增时调用）
        const ensureRegexScriptsArray = () => {
            const d = safeData.value;
            if (!d || typeof d !== 'object') return null;
            if (!d.extensions) d.extensions = {};
            if (!Array.isArray(d.extensions.regex_scripts)) {
                // 兼容旧结构：若顶层有 regex_scripts 数组则迁移进来
                d.extensions.regex_scripts = Array.isArray(d.regex_scripts) ? d.regex_scripts : [];
            }
            return d.extensions.regex_scripts;
        };

        // 新增一条正则脚本
        const addRegexScript = () => {
            if (!cardData.value) return;
            const arr = ensureRegexScriptsArray();
            if (!arr) return;
            arr.push({
                id: 'regex_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                scriptName: '新建正则脚本',
                findRegex: '',
                replaceString: '',
                placement: [2], // 默认作用于 2: AI 输出
                disabled: false
            });
        };

        // 删除一条正则脚本
        const deleteRegexScript = (index) => {
            if (cardData.value && regexScripts.value[index] !== undefined) {
                regexScripts.value.splice(index, 1);
            }
        };

        // 安全规范化单个正则脚本字段（双向同步 camelCase 与 snake_case，兼容不同前端导出）
        const syncRegexScriptField = (script, field, value) => {
            if (!script) return;
            if (field === 'scriptName') {
                script.scriptName = value;
                script.script_name = value;
            } else if (field === 'findRegex') {
                script.findRegex = value;
                script.find_regex = value;
            } else if (field === 'replaceString') {
                script.replaceString = value;
                script.replace_string = value;
            } else if (field === 'disabled') {
                script.disabled = !!value;
            }
            // 【修复】shallowRef 深层编辑不触发响应式，手动刷新视图（防 Checkbox/文字假死）
            if (cardData.value) { triggerRef(cardData); cardTokensCache.delete(cardData.value); }
        };

        // ================= [ 方法：聊天测卡逻辑 ] =================
        // （已拆分为组合式函数 useChat）

        // 🕸️ 关系图谱 已拆分为组合式函数 useGraph（见下文 setup 尾部调用）

        // ================= Token 消耗与上下文预估 =================
        // 简易 Token 估算算法：中文按 1.5 权重，英文单词按 1.2 权重计算
        // Token 估算函数已提取到 ../utils/tokenEstimate.js（共享 import，见文件顶部）

        // 计算当前卡片各个模块的 Token 消耗明细及总数
        const cardTokenStats = computed(() => {
            if (!cardData.value) return { total: 0, desc: 0, pers: 0, scen: 0, first: 0, book: 0 };
            const d = safeData.value;
            
            const desc = estimateTokens(d.description);
            const pers = estimateTokens(d.personality);
            const scen = estimateTokens(d.scenario);
            const first = estimateTokens(d.first_mes);
            
            // 计算所有世界书条目的 Token 总和
            let bookTokens = 0;
            const book = d.character_book || cardData.value?.character_book || {};
            // 🛡️ 全形态安全提取（entries 数组/字典/数组 book），修复脏形态 .forEach 崩溃
            const entries = extractBookEntries(book);
            entries.forEach(e => {
                // 🛡️ keys 非数组脏数据防护（字符串 keys 直接 .join 会 TypeError）
                bookTokens += estimateTokens(e.content) + estimateTokens((Array.isArray(e.keys) ? e.keys : []).join(', '));
            });

            const total = desc + pers + scen + first + bookTokens;
            return { total, desc, pers, scen, first, book: bookTokens };
        });

        // ================= [ 全屏放大文本阅读/编辑器 ] =================
        const showTextModal = ref(false);
        const textModalTitle = ref('');
        const textModalContent = ref('');
        const textModalTargetRef = ref(null);
        const textModalFontSize = ref(14); // 默认字号 14px

        // 打开大文本弹窗
        const openTextModal = (title, targetObj, fieldName) => {
            textModalTitle.value = title;
            textModalTargetRef.value = { obj: targetObj, field: fieldName };
            textModalContent.value = targetObj[fieldName] || '';
            showTextModal.value = true;
        };

        // 保存大文本修改并同步回卡片数据
        const saveTextModal = () => {
            if (textModalTargetRef.value) {
                const { obj, field } = textModalTargetRef.value;
                obj[field] = textModalContent.value;
            }
            showTextModal.value = false;
            // 【修复】shallowRef 深层编辑不触发响应式，手动刷新（全屏编辑器保存后 Token/正文实时更新）
            // 🚀 v1.8.5：正文字段变化影响 Token 估算 → 同步失效缓存
            if (cardData.value) { triggerRef(cardData); cardTokensCache.delete(cardData.value); }
        };

        // ================= [ 高清立绘大图预览 Modal ] =================
        const showImageModal = ref(false);
        const previewImageUrl = ref('');

        const openImageModal = (url) => {
            if (!url) return;
            previewImageUrl.value = url;
            showImageModal.value = true;
        };

        // ================= 全局资产中枢 (世界书/正则共享库) =================
        const showGlobalAssetModal = ref(false);
        const globalAssetTab = ref('worldbook'); // 'worldbook' 或 'regex'

        // 聚合全库所有卡片的世界书条目 (附带所属卡片名字)
        const globalAllWorldbooks = computed(() => {
            const list = [];
            library.value.forEach(item => {
                const d = item.data?.data || item.data || {};
                const book = d.character_book || item.data?.character_book || {};
                // 🛡️ 全形态安全提取（entries 数组/字典/数组 book），修复脏形态 .forEach 崩溃
                const entries = extractBookEntries(book);
                entries.forEach(e => {
                    list.push({
                        ...e,
                        displayName: e.name || e.comment || '未命名条目',
                        ownerCardName: d.name || item.name || '未知角色'
                    });
                });
            });
            return list;
        });

        // 聚合全库所有卡片的正则脚本
        const globalAllRegexScripts = computed(() => {
            const list = [];
            library.value.forEach(item => {
                const d = item.data?.data || item.data || {};
                const regex = d.extensions?.regex_scripts || d.regex_scripts || [];
                regex.forEach(r => {
                    list.push({
                        ...r,
                        ownerCardName: d.name || item.name || '未知角色'
                    });
                });
            });
            return list;
        });

        // 导航标签（含图标与数量徽标；Raw JSON 页签可按视图设置隐藏）
        const tabs = computed(() => {
            const list = [
                { id: 'basic', name: '基础设定', icon: '📖' },
                { id: 'advanced', name: '进阶设定', icon: '🛠️' },
                { id: 'worldbook', name: '世界书', icon: '🌍', badge: worldbookEntries.value.length || null },
                { id: 'regex', name: '正则脚本', icon: '⚙️', badge: regexScripts.value.length || null },
                { id: 'statusbar', name: '美化/状态栏', icon: '📊', badge: renderableScripts.value.length || null },
                { id: 'chat', name: '聊天测试', icon: '💬', action: initChat },
                { id: 'raw', name: 'Raw JSON', icon: '💻' }
            ];
            return list.filter(t => {
                if (t.id === 'raw' && !viewOptions.value.showRawJson) return false;
                if (t.id === 'worldbook' && !viewOptions.value.showWorldbook) return false;
                if (t.id === 'regex' && !viewOptions.value.showRegex) return false;
                return true;
            });
        });

        const currentTabInfo = computed(() => tabs.value.find(t => t.id === currentTab.value) || tabs.value[0]);

        const formattedJson = computed(() => {
            return cardData.value ? JSON.stringify(cardData.value, null, 2) : '';
        });

        // ================= [ 性能优化：搜索防抖 ] =================
        // （搜索防抖/全字段过滤/分页计算已拆分为组合式函数 useSearch）

        // 正则作用域（placement）可读化
        const getRegexPlacement = (arr) => {
            // ✅ [补丁] 严格判定：区分 0 与 null/undefined（旧版 `!arr` 会把 placement:0 误判为默认）
            if (arr === undefined || arr === null) return '默认';
            const map = { 0: '全局/未定义', 1: '用户输入', 2: 'AI回复', 3: '全文本' };
            return Array.isArray(arr) ? arr.map(i => map[i] || i).join(', ') : map[arr] || arr;
        };

        // 原生提示框封装：替代浏览器 alert()，弹出 Electron 原生对话框
        const nativeAlert = async (message, type = 'info', title = '系统提示') => {
            if (!window.electronAPI) return alert(message); // 浏览器环境回退
            await window.electronAPI.showMessage({
                type: type, // 'none' | 'info' | 'error' | 'question' | 'warning'
                title: title,
                message: message,
                buttons: ['确定']
            });
        };

        // 主题切换（暗夜极客 dark / 雅致青灰 slate / 明亮白昼 light）
        const applyTheme = (t) => {
            document.documentElement.setAttribute('data-theme', t);
        };
        const setTheme = (t) => {
            theme.value = t;
            try { localStorage.setItem('stc-theme', t); } catch (e) { /* 忽略 */ }
            applyTheme(t);
        };
        const toggleTheme = () => {
            const order = ['dark', 'slate', 'light'];
            const idx = order.indexOf(theme.value);
            setTheme(order[(idx + 1) % order.length]);
        };

        // =========================================================
        // 📏 侧边栏宽度自定义（拖拽把手调节 + localStorage 持久化）
        // =========================================================
        const sidebarEl = ref(null); // 侧边栏 DOM 引用（拖拽时读取当前宽度）
        const sidebarWidth = ref((() => {
            try {
                const w = parseInt(localStorage.getItem('jsTavern_sidebarWidth') || '', 10);
                if (w >= 220 && w <= 520) return w;
            } catch (e) { /* 忽略 */ }
            return 0; // 0 = 使用默认 calc(var(--ui-fs) * 22)
        })());

        // 侧边栏样式：拖拽后使用固定像素宽度；未拖拽时跟随字号缩放
        const sidebarStyle = computed(() => {
            if (sidebarWidth.value > 0) return { width: sidebarWidth.value + 'px', minWidth: '220px' };
            return { width: 'calc(var(--ui-fs, 13px) * 22)', minWidth: '260px' };
        });

        // 拖拽调整侧边栏宽度（min 220 / max 520）
        const startSidebarResize = (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = sidebarEl.value ? sidebarEl.value.offsetWidth : 286;
            const onMove = (ev) => {
                const delta = ev.clientX - startX;
                sidebarWidth.value = Math.max(220, Math.min(520, Math.round(startWidth + delta)));
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                try { localStorage.setItem('jsTavern_sidebarWidth', String(sidebarWidth.value)); } catch (err) { /* 忽略 */ }
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        };

        // 双击把手恢复默认宽度（跟随字号缩放）
        const resetSidebarWidth = () => {
            sidebarWidth.value = 0;
            try { localStorage.removeItem('jsTavern_sidebarWidth'); } catch (e) { /* 忽略 */ }
        };

        // 原生确认对话框（Electron 中 window.confirm 会静默返回 null，须经 dialog.showMessageBox）
        const confirmDialog = async (message) => {
            if (!window.electronAPI) return window.confirm(message);
            const res = await window.electronAPI.showMessage({
                type: 'question',
                title: '确认操作',
                message: message,
                buttons: ['取消', '确定'],
                defaultId: 1,
                cancelId: 0
            });
            return !!(res && res.response === 1);
        };

        // 重置界面外观与个性化设置（不影响 API 配置）
        const resetPersonalizationSettings = async () => {
            if (!(await confirmDialog('是否确定重置界面字号与外观设置？（API 配置将保持不变）'))) return;
            // 保留酒馆推送地址，避免误重置
            const prevTavernUrl = appSettings.value.tavernUrl || 'http://127.0.0.1:8000';
            const prevTavernLocalPath = appSettings.value.tavernLocalPath || '';
            const prevPushTargetMode = appSettings.value.pushTargetMode || 'sillytavern';
            const prevCustomPushPath = appSettings.value.customPushPath || '';
            const prevCustomPushName = appSettings.value.customPushName || '';
            const prevCustomPushTargets = Array.isArray(appSettings.value.customPushTargets) ? JSON.parse(JSON.stringify(appSettings.value.customPushTargets)) : [];
            const prevCurrentPushTargetId = appSettings.value.currentPushTargetId || '';
            appSettings.value = {
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif",
                fontSize: 14,
                fontWeight: 'normal',
                uiFontSize: 13,
                tavernUrl: prevTavernUrl,
                tavernLocalPath: prevTavernLocalPath,
                pushTargetMode: prevPushTargetMode,
                customPushPath: prevCustomPushPath,
                customPushName: prevCustomPushName,
                customPushTargets: prevCustomPushTargets,
                currentPushTargetId: prevCurrentPushTargetId
            };
            nativeAlert('界面外观设置已恢复默认！', 'info');
        };

        // 重置 API 接口配置（不影响外观设置）
        const resetApiSettings = async () => {
            if (!(await confirmDialog('是否重置 API 接口地址与 Key / 模型参数？'))) return;
            apiEndpoint.value = 'http://127.0.0.1:1234/v1/chat/completions';
            apiKey.value = '';
            apiModel.value = '';
            availableModels.value = [];
            fetchModelStatus.value = '';
            nativeAlert('API 配置已恢复默认！', 'info');
        };

        // 处理文件读取（含错误提示）
        const handleFile = async (file) => {
            try {
                const { data, imgUrl: url } = await processFile(file);
                cardData.value = data;
                imgUrl.value = url;
                currentTab.value = 'basic';
            } catch (error) {
                console.error(error);
                nativeAlert(ERROR_MESSAGES[error.message] || ERROR_MESSAGES.DEFAULT, 'error');
            }
        };

        // 🖱️ handleDrop（系统级拖拽导入）已迁至 useCardCrud 组合式函数（见下文 setup 中部调用）

        const handleFileUpload = (e) => {
            const file = e.target.files[0];
            if (file) handleFile(file);
            e.target.value = ''; // 重置输入框，允许重复选择同一文件
        };

        // 🌐 downloadCardFromUrl（URL 直链下载导入）已迁至 useCardCrud 组合式函数（见下文 setup 中部调用）

        // 导出 JSON
        const downloadJson = () => {
            if (!cardData.value) return;
            // 【修复】深拷贝时用 replacer 递归剔除 Vue 前端专属字段（_collapsed 折叠状态 / uid 列表防错位 ID），避免污染酒馆标准 JSON 格式
            const cleanData = JSON.parse(JSON.stringify(cardData.value, (k, v) => (k === '_collapsed' || k === 'uid') ? undefined : v));
            const jsonStr = JSON.stringify(cleanData, null, 2);
            const blob = new Blob([jsonStr], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${safeData.value.name || 'character'}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
        };

        // ================= [ Electron 专属逻辑 ] =================

        // 读取并解析单张卡片文件，成功则加入库中（供文件夹加载 / 磁盘扫描共用）
        // 🕵️ 角色卡血统鉴定 isCharacterCardData 已迁至 utils/cardLoader.js（纯函数，随 import 引入）

        // 📥 parseAndAddCard / processElectronFiles / flushDeferredAutoTagSaves /
        //    processAutoTagsAndCategory（导入入库域：staging + 低并发后台落盘 + 自动分类打标）
        //    已整体迁至 useCardCrud 组合式函数（见下文 setup 中部调用）

        // 💽 磁盘卡片扫描 已拆分为组合式函数 useDiskScan（见下文 setup 尾部调用）

        // 【关键】软件启动时，自动无感加载上次的文件夹（Electron 环境）
        // 🔧 全局监听引用（供 onUnmounted 清理，文档第 2 节轻微项：根组件全局监听无 onUnmounted 移除）
        let _gClickHandler = null;
        let _gKeysHandler = null;
        let _eKeysHandler = null;
        onUnmounted(() => {
            if (_gClickHandler) window.removeEventListener('click', _gClickHandler);
            if (_gKeysHandler) window.removeEventListener('keydown', _gKeysHandler);
            if (_eKeysHandler) window.removeEventListener('keydown', _eKeysHandler);
        });
        onMounted(async () => {
            // 🩺 启动耗时统计（排查启动缓慢：各阶段耗时一目了然）
            const _t0 = performance.now();
            const _stage = (name) => console.log(`[startup] ${name}: ${Math.round(performance.now() - _t0)}ms`);
            // =========================================================
            // 🛡️ 统一持久化中枢装载：从 app_config.json（最高权威）恢复全部全局状态
            // 覆盖 localStorage 初始化值——生产模式 app:// 的 localStorage 不持久，物理文件才是权威。
            // ⚠️ 关键：IPC 返回的是纯 JSON 对象（无 Proxy），可直接赋给 ref。
            // =========================================================
            try {
                if (window.electronAPI && typeof window.electronAPI.loadAppConfig === 'function') {
                    const cfg = await window.electronAPI.loadAppConfig();
                    if (cfg && typeof cfg === 'object') {
                        isRestoringConfig.value = true; // 🛡️ 恢复期间统一禁止写盘（防竞态自污染，任何恢复值都不回写磁盘）
                        try {
                            // 全局标签池（globalTags）
                            // 🐛 修复「删除标签后重启复发」：app_config.json 是唯一权威，必须【整体替换】而非【并集合并】。
                            //    否则生产模式(app://)下 localStorage 不持久、初始化回退到内置默认池，
                            //    并集会把「已删除的默认标签」重新带回（"一键清空"也会被忽略）。
                            if (Array.isArray(cfg.globalTags)) {
                                const cleanTags = cfg.globalTags.filter(t => typeof t === 'string' && t.trim() !== '');
                                systemCommonTags.value = Array.from(new Set(cleanTags));
                            }
                            // 🏷️ 自动打标规则表（v2.1 可配置；合法元素才恢复，空数组 = 默认规则）
                            if (Array.isArray(cfg.autoTagRules)) {
                                const cleanRules = cfg.autoTagRules
                                    .filter(r => r && typeof r.name === 'string' && r.name.trim() && typeof r.regex === 'string' && r.regex.trim())
                                    .map(r => ({ name: r.name.trim(), regex: r.regex.trim() }));
                                autoTagRules.value = cleanRules;
                            }
                            // ✏️ 自定义关键词库（用户添加的候选词，v2.1）
                            if (Array.isArray(cfg.customKeywords)) {
                                customKeywords.value = cfg.customKeywords.filter(w => typeof w === 'string' && w.trim() !== '');
                            }
                            // 自定义分组（空数组也要覆盖，尊重「全部删除」结果）
                            if (Array.isArray(cfg.customCategories)) {
                                const clean = cfg.customCategories.filter(c => typeof c === 'string' && c.trim() !== '');
                                customCategories.value = clean;
                            }
                            // 删除/重命名的预设分组记录
                            if (Array.isArray(cfg.removedDefaultKeys)) {
                                removedDefaultKeys.value = cfg.removedDefaultKeys;
                                defaultCategories.value = allDefaultCategories.filter(c => !removedDefaultKeys.value.includes(c.key));
                            }
                            // 标签语言模式
                            if (cfg.tagLangMode === 'cn' || cfg.tagLangMode === 'en' || cfg.tagLangMode === 'both') {
                                tagLangMode.value = cfg.tagLangMode;
                            }
                            // 卡片属性物理覆盖表（防重扫冲刷的核心数据）
                            if (cfg.cardOverlays && typeof cfg.cardOverlays === 'object') {
                                appConfig.value.cardOverlays = cfg.cardOverlays;
                            }
                            // 📥 卡片导入时间映射（「导入时间」排序跨重启持久化）
                            if (cfg.cardImportTimes && typeof cfg.cardImportTimes === 'object') {
                                cardImportTimes.value = { ...cardImportTimes.value, ...cfg.cardImportTimes };
                            }
                            // API 配置（空串也要覆盖，尊重「清空」结果）
                            if (cfg.api && typeof cfg.api === 'object') {
                                if (typeof cfg.api.endpoint === 'string') apiEndpoint.value = cfg.api.endpoint;
                                if (typeof cfg.api.key === 'string') {
                                    apiKey.value = cfg.api.key;
                                    // 🔐 解密后使用（代码审查修复 2）：兼容旧明文——解密失败回退原值
                                    if (cfg.api.key && window.electronAPI && typeof window.electronAPI.decryptSecret === 'function') {
                                        try {
                                            const dec = await window.electronAPI.decryptSecret(cfg.api.key);
                                            if (dec && dec.success && typeof dec.value === 'string') apiKey.value = dec.value;
                                        } catch (e) { /* 回退明文 */ }
                                    }
                                }
                                if (typeof cfg.api.model === 'string') apiModel.value = cfg.api.model;
                                if (cfg.api.type === 'anthropic' || cfg.api.type === 'openai') apiType.value = cfg.api.type;
                            }
                            // 🧩 UI 状态恢复（app_config.json 权威）
                            if (cfg.ui && typeof cfg.ui === 'object') {
                                if (typeof cfg.ui.theme === 'string' && cfg.ui.theme) theme.value = cfg.ui.theme;
                                if (cfg.ui.appSettings && typeof cfg.ui.appSettings === 'object') {
                                    appSettings.value = { ...appSettings.value, ...cfg.ui.appSettings };
                                }
                                if (typeof cfg.ui.sanitizeImportedTags === 'boolean') sanitizeImportedTags.value = cfg.ui.sanitizeImportedTags;
                                if (cfg.ui.snapshotConfig && typeof cfg.ui.snapshotConfig === 'object') {
                                    snapshotConfig.value = { ...snapshotConfig.value, ...cfg.ui.snapshotConfig };
                                }
                                if (cfg.ui.localCategoryMap && typeof cfg.ui.localCategoryMap === 'object') {
                                    localCategoryMap.value = { ...localCategoryMap.value, ...cfg.ui.localCategoryMap };
                                }
                                if (typeof cfg.ui.sidebarWidth === 'number') sidebarWidth.value = cfg.ui.sidebarWidth;
                                if (cfg.ui.viewMode === 'list' || cfg.ui.viewMode === 'grid') viewMode.value = cfg.ui.viewMode;
                                if (typeof cfg.ui.isCompactMode === 'boolean') isCompactMode.value = cfg.ui.isCompactMode;
                                if (['importTime', 'time', 'name', 'nameDesc', 'mtime', 'ctime', 'sizeDesc', 'sizeAsc', 'tokens'].includes(cfg.ui.sortBy)) sortBy.value = cfg.ui.sortBy;
                                if (Array.isArray(cfg.ui.systemPromptPresets) && cfg.ui.systemPromptPresets.length) {
                                    systemPromptPresets.value = cfg.ui.systemPromptPresets;
                                }
                                if (typeof cfg.ui.lastWorldbookDirPath === 'string') lastWorldbookDirPath.value = cfg.ui.lastWorldbookDirPath;
                                if (typeof cfg.ui.lastPresetDirPath === 'string') lastPresetDirPath.value = cfg.ui.lastPresetDirPath;
                                if (cfg.ui.wbCategoryMap && typeof cfg.ui.wbCategoryMap === 'object') {
                                    wbCategoryMap.value = { ...wbCategoryMap.value, ...cfg.ui.wbCategoryMap };
                                }
                            }
                        } finally {
                            isRestoringConfig.value = false;
                        }
                    }
                } else if (window.electronAPI && typeof window.electronAPI.getUiSettings === 'function') {
                    // 旧版兼容回退：从 tavern_manager_config.json 的 uiSettings 读取（无 app_config.json 的旧环境）
                    const ui = await window.electronAPI.getUiSettings();
                    if (ui) {
                        if (Array.isArray(ui.customCategories)) {
                            const clean = ui.customCategories.filter(c => typeof c === 'string' && c.trim() !== '');
                            if (clean.length) customCategories.value = clean;
                        }
                        if (Array.isArray(ui.removedDefaultKeys)) {
                            removedDefaultKeys.value = ui.removedDefaultKeys;
                            // 按最新删除/重命名记录重新过滤生效预设
                            defaultCategories.value = allDefaultCategories.filter(c => !removedDefaultKeys.value.includes(c.key));
                        }
                        if (ui.tagLangMode === 'cn' || ui.tagLangMode === 'en' || ui.tagLangMode === 'both') {
                            tagLangMode.value = ui.tagLangMode;
                        }
                        if (ui.localCategoryMap && typeof ui.localCategoryMap === 'object') {
                            localCategoryMap.value = ui.localCategoryMap;
                        }
                    }
                }
            } catch (e) { /* 忽略 */ }

            // 📸 恢复权威快照配置（app_config.json）后、加载卡片触发 saveCard 之前，
            //    再把正确配置同步到主进程——防止用 localStorage 默认值反向覆盖主进程、
            //    以及启动加载卡片时误生成自动快照。
            await saveSnapshotSettings();

            _gClickHandler = handleGlobalClick;
            window.addEventListener('click', _gClickHandler); // 点击任意处关闭右键菜单
            applyTheme(theme.value); // 应用已保存的主题

            // 全局快捷键：Ctrl+S 保存 / Ctrl+O 打开角色库 / Ctrl+I 导入卡片
            const handleGlobalKeys = (e) => {
                if (!(e.ctrlKey || e.metaKey)) return;
                const k = e.key.toLowerCase();
                if (k === 's') { e.preventDefault(); saveCurrentAsset(); } // 【修复】Ctrl+S 走智能保存路由，避免世界书模式下误保存角色卡
                else if (k === 'o') { e.preventDefault(); selectFixedDirectory(); }
                else if (k === 'i') { e.preventDefault(); importCards(); }
                else if (k === 'a') {
                    // 批量模式下全选（输入框内不拦截，保留原生全选文本能力）
                    const tag = document.activeElement?.tagName;
                    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
                    e.preventDefault();
                    selectAllCards();
                }
            };
            _gKeysHandler = handleGlobalKeys;
            window.addEventListener('keydown', _gKeysHandler);

            // 🌟 扩展快捷键：Ctrl+F 聚焦搜索 / Delete 移入回收站 / Esc 退出多选或关闭预览
            const handleExtendedKeys = async (e) => {
                const tag = document.activeElement?.tagName;
                const isInputFocused = tag === 'INPUT' || tag === 'TEXTAREA';

                // Ctrl+F：聚焦全局搜索框（即使已在输入框也允许，覆盖浏览器默认查找）
                if (e.ctrlKey && e.key.toLowerCase() === 'f') {
                    e.preventDefault();
                    const searchInput = document.getElementById('global-search-input');
                    if (searchInput) { searchInput.focus(); searchInput.select(); }
                    return;
                }

                // Delete 键：移入回收站（输入框内不拦截，保留文本删除能力）
                if (e.key === 'Delete' && !isInputFocused) {
                    if (isMultiSelectMode.value && selectedIds.value.length > 0) {
                        // 批量移入全局回收站
                        const ok = await confirmDialog(`确定将选中的 ${selectedIds.value.length} 张卡片移入回收站吗？`);
                        if (ok) {
                            const paths = library.value
                                .filter(i => selectedIds.value.includes(i.id))
                                .map(i => i.path);
                            const res = await window.electronAPI.trashFiles(paths);
                            if (res && res.success) {
                                library.value = library.value.filter(i => !selectedIds.value.includes(i.id));
                                selectedIds.value = [];
                                await cleanupEmptyCategories(); // 🧹 自动清理空分组
                                showToast(`已移入回收站 ${paths.length} 张卡片`, 'info');
                            }
                        }
                    } else if (cardData.value) {
                        // 当前打开的卡片移入回收站
                        const libItem = library.value.find(item => item.data === cardData.value);
                        if (libItem) deleteCardItem(libItem);
                    }
                    return;
                }

                // Esc 键：关闭图片预览 / 退出多选模式
                if (e.key === 'Escape') {
                    if (showImageModal.value) { showImageModal.value = false; }
                    else if (isMultiSelectMode.value) {
                        isMultiSelectMode.value = false;
                        selectedIds.value = [];
                        showToast('已退出多选模式', 'info', 1500);
                    }
                }
            };
            _eKeysHandler = handleExtendedKeys;
            window.addEventListener('keydown', _eKeysHandler);

            if (!window.electronAPI) {
                // 【健壮性】纯浏览器环境（无 preload）也应放行加载蒙版，避免永久卡在加载画面
                isAppLoading.value = false;
                return;
            }
            try {
                const lastData = await window.electronAPI.loadConfig();
                _stage('主进程扫描(loadConfig)');
                if (lastData && lastData.folderPath) {
                    // 🚀 v2.3 多线程并发解析（Worker 分核）：全量解析完成后一次入库，
                    //    首屏等待由 Worker 并行大幅压缩（放弃流式，避免加载期 UI 反复重算）
                    await processElectronFiles(lastData);
                    _stage('渲染端解析卡片');
                }
            } catch (err) {
                console.warn('自动加载上次文件夹失败', err);
            }

            // 🌍⚡ 并行恢复世界书库 + 预设目录（互不依赖，原串行 await 改并行省一倍等待）
            const _secondaryLoads = [];
            if (lastWorldbookDirPath.value) {
                _secondaryLoads.push((async () => {
                    try {
                        await scanWorldbookDir(lastWorldbookDirPath.value);
                        _stage('世界书扫描');
                        addLog(`📂 自动记忆载入世界书库: ${lastWorldbookDirPath.value}`);
                    } catch (err) {
                        console.warn('自动加载世界书目录失败', err);
                    }
                })());
            }
            if (lastPresetDirPath.value) {
                _secondaryLoads.push((async () => {
                    try {
                        await scanPresetDir(lastPresetDirPath.value);
                        _stage('预设扫描');
                        addLog(`📂 自动记忆载入预设目录: ${lastPresetDirPath.value}`);
                    } catch (err) {
                        console.warn('自动加载预设目录失败', err);
                    }
                })());
            }
            if (_secondaryLoads.length > 0) {
                await Promise.all(_secondaryLoads);
            }

            // 数据加载完毕，淡出启动加载蒙版
            isAppLoading.value = false;
            _stage('蒙版淡出(总耗时)');

            // 🚀 后台静默检测更新（延迟 3 秒，不卡首屏；无新版本不打扰）
            setTimeout(() => { silentCheckForUpdates(); }, 3000);
        });

        // 手动贴标签（单张卡片：内存 customTags + 原生 data.tags 双写，并物理落盘）
        const addManualTag = async (item) => {
            const newTag = await appPrompt(`为 ${item.name} 添加新标签 (多个标签用逗号分隔):`);
            if (newTag) {
                const tags = newTag.split(',').map(t => t.trim()).filter(t => t);
                let isModified = false;

                // 1. 内存自定义标签层
                const newCustom = Array.from(new Set([...(item.customTags || []), ...tags]));
                if (newCustom.length !== item.customTags?.length) {
                    item.customTags = newCustom;
                    isModified = true;
                }

                // 2. 原生 data.tags 层（兼容 V1/V2）
                const dataLayer = item.data?.data || item.data || {};
                if (!Array.isArray(dataLayer.tags)) dataLayer.tags = [];
                const newDataTags = Array.from(new Set([...dataLayer.tags, ...tags]));
                if (newDataTags.length !== dataLayer.tags.length) {
                    dataLayer.tags = newDataTags;
                    isModified = true;
                }

                // 3. 统一持久化中枢：写覆盖层 + 物理落盘（防止内存/PNG 单点失败丢数据）
                if (isModified) {
                    await persistCardUpdate(item, { tags: item.customTags, category: item.category });
                }
            }
        };

        // 换页逻辑
        // （changePage 已拆分为组合式函数 useSearch）
        // ================= [ 方法：导出/导入 本地库文件 ] =================

        // 1. 导出数据库文件 (Backup Library)
        const exportLibraryDB = () => {
            if (library.value.length === 0) return nativeAlert("当前库为空，没有需要导出的内容。", 'warning');

            // 只保存关键配置（不保存庞大的图片数据，保持文件轻量）
            const dbData = {
                version: "1.0",
                categories: customCategories.value,
                cardsConfig: {}
            };

            library.value.forEach(item => {
                // 使用卡片名称作为唯一标识符
                dbData.cardsConfig[item.name] = {
                    category: item.category,
                    customTags: item.customTags
                };
            });

            const jsonStr = JSON.stringify(dbData, null, 2);
            const blob = new Blob([jsonStr], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `SillyTavern_Library_DB.json`; // 下载到本地的数据库文件
            a.click();
            URL.revokeObjectURL(a.href);
        };

        // 2. 加载数据库文件 (Load Library)
        const importLibraryDB = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const text = await file.text();
                const dbData = JSON.parse(text);

                if (dbData.categories && Array.isArray(dbData.categories)) {
                    dbData.categories.forEach(c => {
                        // 🔧 修复：只接受「非空字符串」，杜绝空组 / 幽灵分组
                        if (typeof c !== 'string' || c.trim() === '') return;
                        if (!isCategoryKnown(c)) {
                            customCategories.value.push(c);
                        }
                    });
                }
                if (dbData.cardsConfig) {
                    importedConfig.value = dbData.cardsConfig;

                    // 如果当前库里已经有卡片了，立即应用配置
                    library.value.forEach(item => {
                        const config = importedConfig.value[item.name];
                        if (config) {
                            item.category = (typeof config.category === 'string' && config.category.trim() !== '')
                                ? config.category.trim()
                                : item.category;
                            // 🔧 修复：标签只保留「非空字符串」，杜绝空/脏标签注入
                            item.customTags = Array.isArray(config.customTags)
                                ? Array.from(new Set(config.customTags.filter(t => typeof t === 'string' && t.trim() !== '')))
                                : item.customTags;
                        }
                    });
                }
                nativeAlert("库配置导入成功！请点击【读取本地文件夹】扫描你的图片，系统会自动恢复标签和分类。", 'info');
            } catch (err) {
                nativeAlert("导入失败，无效的库文件格式。", 'error');
            }
            e.target.value = '';
        };

        // 从库中点击打开卡片
        const openFromLibrary = (item) => {
            // 🧹 切换卡片时释放上一张卡的 blob 预览（仅 blob: 引用需 revoke；local-file 永久路径无需）
            if (imgUrl.value && imgUrl.value.startsWith('blob:') && imgUrl.value !== (item && item.avatar)) {
                try { URL.revokeObjectURL(imgUrl.value); } catch (e) { /* 忽略 */ }
            }
            cardData.value = item.data;
            imgUrl.value = item.avatar;
            currentTab.value = 'basic';
            // 【关键修复】切换卡片时强制清空聊天记录，确保下次进入聊天 Tab 时重新加载新卡的设定
            chatHistory.value = [];
            // 同时重置世界书折叠状态，避免上一张卡的展开状态残留
            worldbookExpanded.value = {};
            window.scrollTo({ top: 0, behavior: 'smooth' }); // 滚动到顶部查看
        };

        // ✅ 选择逻辑（handleCardClick/toggleSelection/clearSelection）与批量操作悬浮台已拆分为组合式函数 useBatch（见下文 setup 尾部调用）

        // ================= 交互优化：多选开关与右键菜单 =================
        const isMultiSelectMode = ref(false); // 默认隐藏批量复选框

        // ================= [ 视图模式状态（列表 / 网格） ] =================
        // 默认优先读取用户的历史偏好，没有则默认 'list'
        const viewMode = ref((() => {
            try { return localStorage.getItem('jsTavernViewMode') || 'list'; } catch (e) { /* 忽略 */ }
            return 'list';
        })());

        // 切换视图并持久化保存（用户下次打开依然是自己喜欢的视图）
        const toggleViewMode = () => {
            viewMode.value = viewMode.value === 'list' ? 'grid' : 'list';
            try { localStorage.setItem('jsTavernViewMode', viewMode.value); } catch (e) { /* 忽略 */ }
        };

        // ✅ [UI 瘦身] 列表紧凑模式（隐藏副行/缩头像，一屏显示更多卡片；localStorage 持久化）
        const isCompactMode = ref((() => {
            try { return localStorage.getItem('jsTavernCompactMode') === '1'; } catch (e) { return false; }
        })());
        watch(isCompactMode, (v) => {
            try { localStorage.setItem('jsTavernCompactMode', v ? '1' : '0'); } catch (e) { /* 忽略 */ }
        });

        // ✅ [UI 方案1] 列表排序方式：'importTime' 导入最新 | 'time' 本地文件最新 | 'name' A-Z正序 | 'nameDesc' A-Z倒序 | 'mtime' 修改时间 | 'ctime' 创建时间 | 'sizeDesc' 大小倒序 | 'sizeAsc' 大小正序 | 'tokens' Token（localStorage 持久化）
        const sortBy = ref((() => {
            try {
                const s = localStorage.getItem('jsTavernSortBy');
                return ['importTime', 'time', 'name', 'nameDesc', 'mtime', 'ctime', 'sizeDesc', 'sizeAsc', 'tokens'].includes(s) ? s : 'name';
            } catch (e) { return 'name'; }
        })());
        watch(sortBy, (v) => {
            try { localStorage.setItem('jsTavernSortBy', v); } catch (e) { /* 忽略 */ }
        });

        // 右键菜单状态
        const contextMenu = ref({
            visible: false,
            x: 0,
            y: 0,
            item: null
        });

        // 打开右键菜单（带边缘碰撞检测，防止菜单超出屏幕）
        const openContextMenu = (event, item) => {
            event.preventDefault(); // 阻止浏览器默认右键菜单
            if (wbContextMenu.value && wbContextMenu.value.show) closeWbContextMenu(); // 先收起世界书右键菜单
            let x = event.clientX;
            let y = event.clientY;
            // 假设右键菜单最大宽度 210px，最大高度 320px
            if (x + 210 > window.innerWidth) x = window.innerWidth - 210;
            if (y + 320 > window.innerHeight) y = window.innerHeight - 320;
            contextMenu.value = {
                visible: true,
                x: Math.max(x, 4),
                y: Math.max(y, 4),
                item: item
            };
        };

        // 关闭右键菜单
        const closeContextMenu = () => {
            contextMenu.value.visible = false;
        };

        // 📁 右键快速移动分组已拆分为组合式函数 useCardGroups（见下文 setup 尾部调用）

        // 📤 exportCard / 🗑️ deleteCardItem（右键菜单单卡操作）已迁至 useCardCrud 组合式函数（见下文 setup 中部调用）

        // 点击页面任意地方自动关闭右键菜单（角色卡 + 世界书共用）
        const handleGlobalClick = () => {
            if (contextMenu.value.visible) {
                closeContextMenu();
            }
            if (wbContextMenu.value && wbContextMenu.value.show) {
                closeWbContextMenu();
            }
        };

        // =========================================================
        // 🖱️ 右键菜单：增强原生操作（资源管理器定位/物理副本/AI打标/安全回收站）
        // =========================================================
        const handleContextMenuAction = async (action) => {
            const card = contextMenu.value.item;
            if (!card) return;
            closeContextMenu(); // 立即收起菜单

            try {
                switch (action) {
                    case 'openFolder':
                        // 调用系统资源管理器定位文件
                        await window.electronAPI.showItemInFolder(card.path);
                        addLog(`📁 已在资源管理器中定位: ${card.name}`, 'info');
                        break;

                    case 'duplicate': {
                        // 创建卡片物理副本（时间戳后缀）
                        const dupRes = await window.electronAPI.duplicateFile(card.path);
                        if (dupRes && dupRes.success) {
                            addLog(`📋 已成功创建卡片副本: ${card.name}`, 'success');
                            nativeAlert(`【${card.name}】的副本已创建！\n请点击左上角[文件]->[打开角色库目录]刷新查看。`, 'info');
                        } else {
                            throw new Error((dupRes && dupRes.error) || '复制失败');
                        }
                        break;
                    }

                    case 'aiTag': {
                        // 单卡快捷唤起 AI 打标（无需多选模式）
                        // 【修复】若右键的卡片已在多选列表中则保留多选状态，否则才重置为单卡选择
                        if (!selectedIds.value.includes(card.id)) {
                            selectedIds.value = [card.id];
                        }
                        openAITagModal();
                        addLog(`🤖 已为 [${card.name}] 唤起 AI 打标`, 'info');
                        break;
                    }

                    case 'pushTarget': {
                        await pushCardPathsToCurrentTarget([card.path], { sourceName: `角色卡【${card.name}】` });
                        addLog(`🚀 已推送到当前目标: ${card.name}`, 'success');
                        break;
                    }

                    case 'snapshots': {
                        // 📸 查看该卡片的历史快照并支持一键恢复
                        await openSnapshotModal(card);
                        break;
                    }

                    case 'trash': {
                        // 安全移入全局回收站（userData/jsTavern_Trash，绝不物理删除）
                        // ⚠️ 必须用 confirmDialog（window.confirm 在 Electron 中静默返回 null）
                        const ok = await confirmDialog(`确定要将【${card.name}】移入安全回收站吗？\n(可在 文件(F)->查看回收站 找回)`);
                        if (!ok) break;
                        const trashRes = await window.electronAPI.trashFiles([card.path]);
                        if (trashRes && trashRes.success) {
                            const wasCurrent = !!(cardData.value && card.data === cardData.value);
                            // 动态从内存中剔除，无需刷新
                            library.value = library.value.filter(c => c.path !== card.path);
                            if (wasCurrent) reset();
                            await cleanupEmptyCategories(); // 🧹 自动清理空分组
                            addLog(`🗑️ 已将卡片移入回收站: ${card.name}`, 'warning');
                            nativeAlert('已安全移入回收站。', 'info');
                        } else {
                            throw new Error((trashRes && trashRes.error) || '移入回收站失败');
                        }
                        break;
                    }
                }
            } catch (err) {
                nativeAlert(`操作失败: ${err.message}`, 'error');
                addLog(`❌ 右键操作失败: ${err.message}`, 'error');
            }
        };

        // ================= [ 方法：批量操作 ] =================
        // 📁 批量移动分类已拆分为组合式函数 useCardGroups（见下文 setup 尾部调用）

        // 📁 批量移动分组（弹窗版）已拆分为组合式函数 useCardGroups（见下文 setup 尾部调用）

        // ✅ 批量打包导出/批量删除/批量添加标签 已拆分为组合式函数 useBatch（见下文 setup 尾部调用）

        // 🧹 清理空分组已拆分为组合式函数 useCardGroups（见下文 setup 尾部调用）

        // ✅ 批量添加标签（batchAddTag）已拆分为组合式函数 useBatch（见下文 setup 尾部调用）

        // ================= [ 系统级常用标签池 (超级扩充版) ] =================
        // 统一数据源：批量设置弹窗与 AI 打标候选池共享（点击即加，无需手动输入）
        // 内置 40+ 精选分类标签；localStorage 键 customSystemTags 保存用户自定义标签（越用越懂你）
        const systemCommonTags = ref((() => {
            const defaults = [
                // 📌 1. 基础/性别 (Base/Gender)
                'Male (男性)', 'Female (女性)', 'Futa (扶她)', 'Non-binary (非二元)', 'Multiple Characters (多角色)',

                // 📌 2. 种族/物种 (Species)
                'Human (人类)', 'Elf (精灵)', 'Demon (恶魔)', 'Angel (天使)', 'Vampire (吸血鬼)',
                'Succubus/Incubus (魅魔/梦魇)', 'Furry (兽人/福瑞)', 'Monster (怪物/异种)', 'Android (仿生人/机娘)', 'Beastman (亚人/兽耳)',

                // 📌 3. 世界观/题材 (Genre/Setting)
                'Fantasy (奇幻/魔法)', 'Sci-Fi (科幻)', 'Cyberpunk (赛博朋克)', 'Steampunk (蒸汽朋克)',
                'Modern (现代都市)', 'Historical (历史/古代)', 'Post-Apocalyptic (末世/废土)',
                'Isekai (异世界/穿越)', 'School (校园)', 'Workplace (职场)', 'Cultivation (修仙/仙侠)',

                // 📌 4. 角色属性/XP/性格 (Personality/Tropes)
                'Yandere (病娇)', 'Tsundere (傲娇)', 'Kuudere (三无)', 'Submissive (顺从/M)', 'Dominant (强势/S)',
                'Maid/Butler (女仆/执事)', 'Villain (反派)', 'Master/Slave (主仆)', 'Royalty (皇室/贵族)',
                'Step-family (继亲)', 'Childhood Friend (青梅竹马)', 'MILF/Oyakodon (熟女/太太)',

                // 📌 5. 内容分级与基调 (Rating/Tone)
                'SFW (全年龄/安全)', 'NSFW (成人/敏感)', 'Wholesome (纯爱/温馨)', 'Dark (暗黑/虐心)',
                'Romance (恋爱)', 'Action (战斗/动作)', 'Horror (恐怖/悬疑)', 'Comedy (搞笑/轻松)',
                'Smut (搞颜色)', 'Slow Burn (慢热)', 'Corruption (堕落/恶堕)',

                // 📌 6. 卡片功能类型 (Card Type)
                'RPG (文字游戏/跑团)', 'Scenario (特定情景剧)', 'Narrator (旁白驱动)', 'Assistant (AI助手/工具卡)'
            ];
            // 优先读取 localStorage 中用户自定义的标签（越用越懂你）；无记录/损坏时回退默认池
            // 🐛 修复「删除标签后重启复发」：旧逻辑用「默认标签命中率 < 50% 即判定污染并回填默认」，
            //    删掉超过一半默认标签后，重启会把已删除的默认标签全部复活。
            //    现在：只要存在有效保存记录（含空数组 = 用户主动清空），一律尊重保存结果，绝不自动回填默认。
            try {
                const saved = JSON.parse(localStorage.getItem('customSystemTags'));
                if (Array.isArray(saved)) {
                    const clean = saved.filter(t => typeof t === 'string' && t.trim() !== '');
                    return Array.from(new Set(clean));
                }
            } catch (e) { /* 忽略 */ }
            return defaults;
        })());

        // 系统/常用标签库变化时自动持久化：统一配置中枢（app_config.json 唯一权威）+ localStorage 兜底（浏览器环境）
        // （写盘 guard 已内置于 syncConfigToDisk，启动恢复期间不会落盘）
        watch(systemCommonTags, (val) => {
            try { syncConfigToDisk(); } catch (e) { /* 忽略 */ }
            try { localStorage.setItem('customSystemTags', JSON.stringify(val)); } catch (e) { /* 忽略 */ }
        }, { deep: true });

        // ⚠️ 已移除 loadGlobalTagsFromDisk()：旧文件 tavern_manager_config.json 的读取路径与
        //    app_config.json 权威加载形成竞态（两个不同文件互相覆盖），是「删除标签重启复发」的根源。
        //    旧文件 globalTags 的迁移已在 main.js sys:loadConfig 首次启动时一次性完成，无需再读取。

        // ================= 🏷️ 自动打标规则表（v2.1 可扩展 + 用户可配置） =================
        // 存 [{name, regex}] 数组到 app_config.json（权威）；空数组 = 使用默认规则表。
        // 编译结果 compiledAutoTagRules 注入 useCardCrud（导入自动分类）与 useAITools（打标第一层）。
        const autoTagRules = ref([]); // 用户配置的规则表（[{name, regex}]，字符串可序列化）
        const showAutoTagRulesModal = ref(false); // 规则编辑弹窗显隐
        const compiledAutoTagRules = computed(() => compileAutoTagRules(autoTagRules.value));

        // 保存规则表（UI 编辑弹窗确认时调用；空数组 = 恢复默认规则）
        // ⚠️ syncConfigToDisk 定义于 useConfigPersistence（setup 尾部），此处仅声明函数体（用户交互时才执行，闭包安全）
        const saveAutoTagRules = (list) => {
            const clean = Array.isArray(list)
                ? list
                    .map(r => ({ name: String(r && r.name || '').trim(), regex: String(r && r.regex || '').trim() }))
                    .filter(r => r.name && r.regex)
                : [];
            autoTagRules.value = clean;
            syncConfigToDisk(); // 立即落盘（不用 debounce，规则即时生效）
        };
        // 恢复默认规则表
        const resetAutoTagRules = () => {
            autoTagRules.value = [];
            syncConfigToDisk();
        };

        // ✏️ 自定义关键词库（用户添加到候选池的词，持久化；供「自定义规则」选词）
        const customKeywords = ref([]);
        // 添加自定义关键词（去重 + 立即落盘）
        const addCustomKeyword = (word) => {
            const clean = String(word || '').trim();
            if (clean && !customKeywords.value.includes(clean)) {
                customKeywords.value.push(clean);
                syncConfigToDisk();
            }
        };
        // 删除自定义关键词
        const removeCustomKeyword = (word) => {
            customKeywords.value = customKeywords.value.filter(w => w !== word);
            syncConfigToDisk();
        };

        // ================= 标签中英文切换系统 =================
        // 标签语言模式: 'cn' (纯中文), 'en' (纯英文), 'both' (中英双语)
        // 【修复】localStorage 持久化，重启保持上次选择
        const tagLangMode = ref((() => {
            try {
                const saved = localStorage.getItem('jsTavern_tagLangMode');
                if (saved === 'cn' || saved === 'en' || saved === 'both') return saved;
            } catch (e) { /* 忽略 */ }
            return 'both';
        })());
        watch(tagLangMode, (v) => {
            try { localStorage.setItem('jsTavern_tagLangMode', v); } catch (e) { /* 忽略 */ }
            saveUiSettingsToDisk(); // 内部已走统一中枢 syncConfigToDisk
        });

        // 🏷️ 批量标签/预设标签/标签中英文切换/全局标签库 已拆分为组合式函数 useTags（见下文 setup 尾部调用）
        // 🧠 系统提示词预设（跨模块共享状态：被 syncConfigToDisk / 集中 watch 引用，保留在 App.vue；打标相关操作方法见 useAITools）
        const systemPromptPresets = ref((() => {
            try {
                const saved = JSON.parse(localStorage.getItem('jsTavernSysPrompts'));
                if (Array.isArray(saved) && saved.length > 0) return saved;
            } catch (e) { /* 忽略 */ }
            return [
                {
                    id: 'preset_1',
                    name: '标准标签提取助手',
                    content: '你是一个专业的角色卡分析助手。请阅读以下角色设定，提取最符合角色的标签。请严格只返回一个 JSON 数组格式（例如：["标签1", "标签2"]），绝对不要返回任何其他说明文字。',
                    expanded: false
                },
                {
                    id: 'preset_2',
                    name: '精简短标签模式 (2-4个)',
                    content: '你是一个精准的标签归纳专家。请为该角色提取 2-4 个极度精简的核心短标签。输出必须是纯 JSON 数组格式，形如 ["词1", "词2"]，不要附加任何解释。',
                    expanded: false
                }
            ];
        })());

        // ✨ AI 打标 / 翻译 / 格式升维 已拆分为组合式函数 useAITools（见下文 setup 尾部调用）

        // ================= [ 方法：重命名与导出世界书 ] =================

        // ✏️ renameCard（重命名当前卡片）已迁至 useCardCrud 组合式函数（见下文 setup 中部调用）

        // 导出世界书 (Lorebook) 为独立的 JSON 文件
        const exportWorldbook = () => {
            if (!cardData.value) return;
            const book = safeData.value.character_book;

            // 🛡️ 全形态安全判定（数组 book 的 .entries 是原型方法函数，旧写法会误判长度为 0）
            if (extractBookEntries(book).length === 0) {
                return nativeAlert("此卡片没有世界书数据可供导出。", 'warning');
            }

            // 拷贝一份世界书数据
            const wbData = JSON.parse(JSON.stringify(book));
            // 如果原世界书没有名字，用角色名生成一个
            if (!wbData.name) {
                wbData.name = `${safeData.value.name || 'Character'}_Lorebook`;
            }

            const jsonStr = JSON.stringify(wbData, null, 2);
            const blob = new Blob([jsonStr], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${wbData.name}.json`;
            a.click();
            URL.revokeObjectURL(a.href);
        };

        const reset = () => {
            cardData.value = null;
            if (imgUrl.value) URL.revokeObjectURL(imgUrl.value);
            imgUrl.value = null;
        };

        // 🗑️ deleteCard（删除当前打开卡片入回收站）已迁至 useCardCrud 组合式函数（见下文 setup 中部调用）

        // 更新名称绑定 (处理 V1 / V2 差异)
        // 🛡️ 防抖刷新列表（万卡下同步 triggerRef(library) 会随每次击键重算 filteredLibrary
        //    全量排序/过滤，输入卡顿；停止输入后 150ms 一次刷新，与 flushLibraryReactivity 同思路）
        let _nameFlushTimer = null;
        const flushLibraryAfterNameChange = () => {
            if (_nameFlushTimer) clearTimeout(_nameFlushTimer);
            _nameFlushTimer = setTimeout(() => {
                _nameFlushTimer = null;
                triggerRef(library);
            }, 150);
        };

        const updateName = (val) => {
            if (!cardData.value) return;
            if (cardData.value.data) cardData.value.data.name = val;
            else cardData.value.name = val;
            const libItem = library.value.find(item => item.data === cardData.value);
            if (libItem) libItem.name = val;
            // 🛡️ shallowRef 修复：修改 cardData 内部对象不触发响应式（编辑器即时响应，与其他字段 refreshCardData 一致）
            if (cardData.value) { triggerRef(cardData); cardTokensCache.delete(cardData.value); }
            // 🛡️ 列表名刷新用防抖（避免每击键触发万卡 filteredLibrary 全量重算）
            flushLibraryAfterNameChange();
        };

        // ================= 单卡标签管理 =================
        // 弹窗状态（Electron 不支持 window.prompt，改用自建 Vue 弹窗输入）
        const tagModalVisible = ref(false);
        const tagInput = ref('');
        const tagModalTitle = ref('为当前角色添加新标签');

        // 获取当前正在编辑的卡片的标签
        const activeCardTags = computed(() => {
            const libItem = library.value.find(item => item.data === cardData.value);
            return libItem ? libItem.customTags : [];
        });

        const addSingleTag = () => {
            const libItem = library.value.find(item => item.data === cardData.value);
            if (!libItem) return;
            tagInput.value = '';
            tagModalTitle.value = `为 ${libItem.name || '当前角色'} 添加新标签`;
            tagModalVisible.value = true;
            // 打开后自动聚焦输入框
            nextTick(() => {
                const el = document.getElementById('single-tag-input');
                if (el) el.focus();
            });
        };

        // 单卡手动输入贴标签（内存 customTags + 原生 data.tags 双写，并物理落盘）
        const confirmSingleTag = async () => {
            const libItem = library.value.find(item => item.data === cardData.value);
            if (libItem && tagInput.value.trim()) {
                const tags = tagInput.value.split(',').map(t => t.trim()).filter(t => t);
                let isModified = false;

                // 1. 更新内存自定义标签层
                const newCustom = Array.from(new Set([...(libItem.customTags || []), ...tags]));
                if (newCustom.length !== libItem.customTags?.length) {
                    libItem.customTags = newCustom;
                    isModified = true;
                }

                // 2. 同步到物理卡片原生的 data.tags 层（兼容 V1/V2）
                const dataLayer = libItem.data?.data || libItem.data || {};
                if (!Array.isArray(dataLayer.tags)) dataLayer.tags = [];
                const newDataTags = Array.from(new Set([...dataLayer.tags, ...tags]));
                if (newDataTags.length !== dataLayer.tags.length) {
                    dataLayer.tags = newDataTags;
                    isModified = true;
                }

                // 3. 统一持久化中枢：写覆盖层 + 物理落盘
                if (isModified) {
                    await persistCardUpdate(libItem, { tags: libItem.customTags, category: libItem.category });
                }
            }
            tagModalVisible.value = false;
        };

        const closeSingleTagModal = () => {
            tagModalVisible.value = false;
        };

        // ================= 通用输入弹窗（替代 Electron 不支持的 window.prompt） =================
        const promptModalVisible = ref(false);
        const promptModalTitle = ref('');
        const promptInput = ref('');
        const promptModalDefault = ref('');
        let promptModalResolve = null; // 保存 promise 回调

        // 打开通用输入弹窗，返回 Promise<string|null>（取消返回 null）
        const appPrompt = (title, defaultValue = '') => {
            // 🔧 重入保护：上一个弹窗未关闭时先结清其 Promise（按取消处理），
            // 避免回调被覆盖导致第一个 await 永久挂起 + 闭包内存泄漏
            if (promptModalResolve) {
                promptModalResolve(null);
                promptModalResolve = null;
            }
            promptModalTitle.value = title;
            promptModalDefault.value = defaultValue;
            promptInput.value = defaultValue;
            promptModalVisible.value = true;
            nextTick(() => {
                const el = document.getElementById('app-prompt-input');
                if (el) el.focus();
            });
            return new Promise((resolve) => {
                promptModalResolve = resolve;
            });
        };

        const confirmPrompt = () => {
            if (promptModalResolve) promptModalResolve(promptInput.value);
            promptModalVisible.value = false;
            promptModalResolve = null;
        };

        const cancelPrompt = () => {
            if (promptModalResolve) promptModalResolve(null);
            promptModalVisible.value = false;
            promptModalResolve = null;
        };

        // ================= 通用选项选择弹窗（替代手输名称，如右键换组/批量移动分组） =================
        const selectModalVisible = ref(false);
        const selectModalTitle = ref('');
        const selectModalOptions = ref([]);   // [{ label, value }]
        const selectModalDefault = ref('');   // 标记"当前"选项
        const selectModalAllowCreate = ref(false); // 是否允许新建
        let selectModalResolve = null; // 保存 promise 回调

        // 打开通用选项选择弹窗，返回 Promise<string|null>（选择返回所选 value；取消返回 null）
        const appSelect = (title, options, { allowCreate = false, defaultValue = '' } = {}) => {
            // 🔧 重入保护：上一个弹窗未关闭时先结清其 Promise（按取消处理）
            if (selectModalResolve) {
                selectModalResolve(null);
                selectModalResolve = null;
            }
            selectModalTitle.value = title;
            // 兼容纯字符串数组与 { label, value } 对象数组
            selectModalOptions.value = (options || []).map(o => (typeof o === 'string' ? { label: o, value: o } : o));
            selectModalDefault.value = defaultValue || '';
            selectModalAllowCreate.value = !!allowCreate;
            selectModalVisible.value = true;
            return new Promise((resolve) => {
                selectModalResolve = resolve;
            });
        };

        const confirmSelect = (value) => {
            if (selectModalResolve) selectModalResolve(value);
            selectModalVisible.value = false;
            selectModalResolve = null;
        };

        // 新建分组：同样按所选名称返回（调用方负责移动 + 加入自定义分组）
        const confirmSelectCreate = (name) => {
            if (selectModalResolve) selectModalResolve(name);
            selectModalVisible.value = false;
            selectModalResolve = null;
        };

        const cancelSelect = () => {
            if (selectModalResolve) selectModalResolve(null);
            selectModalVisible.value = false;
            selectModalResolve = null;
        };

        // 删除单卡某个标签（内存 customTags + 原生 data.tags 双清，并物理落盘）
        const removeSingleTag = async (tag) => {
            const libItem = library.value.find(item => item.data === cardData.value);
            if (!libItem) return;

            let isModified = false;

            // 1. 从自定义标签中移除
            if (libItem.customTags && libItem.customTags.includes(tag)) {
                libItem.customTags = libItem.customTags.filter(t => t !== tag);
                isModified = true;
            }

            // 2. 从原生数据层 tags 移除（兼顾旧版卡片的字符串格式）
            const dataLayer = libItem.data?.data || libItem.data || {};
            if (Array.isArray(dataLayer.tags) && dataLayer.tags.includes(tag)) {
                dataLayer.tags = dataLayer.tags.filter(t => t !== tag);
                isModified = true;
            } else if (typeof dataLayer.tags === 'string' && dataLayer.tags.includes(tag)) {
                dataLayer.tags = dataLayer.tags.split(',').map(t => t.trim()).filter(t => t && t !== tag).join(', ');
                isModified = true;
            }

            // 3. 统一持久化中枢：写覆盖层 + 物理落盘
            if (isModified) {
                await persistCardUpdate(libItem, { tags: libItem.customTags, category: libItem.category });
            }
        };

        // 将可能为 Vue 响应式 Proxy 的卡片数据转为可经 IPC 结构化克隆的纯 JSON 对象
        // （直接从左侧库打开时 cardData.value 是 reactive Proxy，直接传 IPC 会报 "An object could not be cloned"）
        const getPlainCardData = () => {
            if (!cardData.value) return null;
            return JSON.parse(JSON.stringify(cardData.value));
        };

        // 覆盖保存当前卡片到本地原文件（经 saveCard IPC）
        const saveToLocalDisk = async () => {
            if (!cardData.value) return;
            const libItem = library.value.find(item => item.data === cardData.value);
            if (!libItem) return nativeAlert("未找到原文件路径。");
            try {
                const res = await window.electronAPI.saveCard(libItem.path, getPlainCardData());
                if (res.success) {
                    // 🦾 回写新 mtime/size：保存会改变磁盘上的修改时间与文件体积，
                    //    不回写则「修改时间/大小」排序继续用扫描时的旧值，
                    //    用户改完卡切排序列表纹丝不动（观感=排序失效）
                    if (res.mtime) libItem._mtime = res.mtime;
                    if (res.size) libItem._size = res.size;
                    // 🛡️ 覆盖保存后同步覆盖层，防止重扫冲刷本次改动
                    const key = (libItem.path || libItem.name || '').toString();
                    if (!appConfig.value.cardOverlays[key]) appConfig.value.cardOverlays[key] = {};
                    appConfig.value.cardOverlays[key].category = libItem.category || '未分类';
                    if (Array.isArray(libItem.customTags)) {
                        appConfig.value.cardOverlays[key].tags = [...libItem.customTags];
                    }
                    syncConfigToDisk();
                    // 🛡️ shallowRef 修复：修改 library 内部对象（mtime/size/内容）后手动刷新，
                    //    让「修改时间/大小」排序与列表描述即时生效（仅回写不 flush 则排序不重算）
                    triggerRef(library);
                    showToast('角色卡保存成功！', 'success');
                }
                else nativeAlert(`保存失败: ${res.error}`, 'error');
            } catch (e) { nativeAlert(`发生错误: ${e.message}`, 'error'); }
        };

        // 一键导出整合包（主卡 + 独立世界书 + 正则脚本）
        const exportPackage = async () => {
            if (!cardData.value) return;
            const libItem = library.value.find(item => item.data === cardData.value);
            if (!libItem) return nativeAlert("未找到原文件路径。", 'warning');
            
            try {
                const res = await window.electronAPI.exportPackage(libItem.path, getPlainCardData());
                if (res.success) {
                    nativeAlert(`整合包导出成功！\n已归档至目录:\n${res.exportDir}`, "info");
                } else if (res.error !== "用户取消操作") {
                    nativeAlert(`导出失败: ${res.error}`, "error");
                }
            } catch (e) {
                nativeAlert(`发生错误: ${e.message}`, "error");
            }
        };

        // =========================================================
        // 🌍 世界书管理器状态与逻辑（独立于角色卡库，主视图双引擎模式）
        // =========================================================

        // 视图切换模式：'characters' (角色卡) | 'worldbooks' (世界书) | 'presets' (预设)
        const appMode = ref('characters');

        const worldbooks = shallowRef([]);   // 🚀 shallowRef：世界书 entries 深层 Proxy 化导致崩溃
        const activeWorldbook = ref(null);   // 当前正在深度编辑的世界书

        // 记忆上次打开的世界书目录（localStorage 持久化，重启自动静默恢复）
        const lastWorldbookDirPath = ref((() => {
            try { return localStorage.getItem('jsTavern_lastWbDir') || ''; } catch (e) { return ''; }
        })());

        // ⚙️ 预设管理状态
        const presets = ref([]);             // 预设列表
        const activePreset = ref(null);      // 当前正在编辑的预设
        const lastPresetDirPath = ref((() => {
            try { return localStorage.getItem('jsTavern_lastPresetDir') || ''; } catch (e) { return ''; }
        })());

        // =========================================================
        // 📟 全局终端控制台与日志状态（角色卡/世界书双模式共用）
        // =========================================================
        const editorLogs = ref([]);
        const showEditorLogs = ref(false); // 默认收起，点击控制杆可随时展开

        // 全局日志打印辅助函数
        const addLog = (msg, type = 'info') => {
            const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            editorLogs.value.unshift({ time, msg, type });
            if (editorLogs.value.length > 100) editorLogs.value.pop(); // 保留最新 100 条
        };

        // 🌍 世界书扫描与加载方法已拆分为组合式函数 useWorldbooks（见下文 setup 尾部调用）

        // 🌍 网址导入状态已拆分为组合式函数 useWorldbooks（见下文 setup 尾部调用）

        // =========================================================
        // 💾 统一 IPC 落盘拦截器：保证没有任何世界书只停留在内存中
        // ---------------------------------------------------------
        // 本应用每本世界书是独立的 .json 文件（非单个数据库文件）：
        //  - 重命名/删除必须按“文件路径”走物理 IPC（renameWorldbookFile / trashFiles）
        //  - 新增/克隆/导入已各自调用 createWorldbook 落盘
        // 因此这里只做“兜底”：把 path 为空（内存态）的世界书补齐保存到世界书目录。
        // ⚠️ 不采用“整体数组覆盖写”：每本书独立文件 + wb:save 每次保存都建快照，
        //    全量写会刷爆 .bak_history 备份目录。
        const syncWorldbooksToDisk = async () => {
            if (!window.electronAPI || typeof window.electronAPI.createWorldbook !== 'function') {
                console.warn('未检测到 Electron IPC 环境，仅在内存中修改。');
                return 0;
            }

            const pending = worldbooks.value.filter(wb => !wb.path);
            if (pending.length === 0) {
                addLog('💾 所有世界书均已落盘，无需同步。', 'info');
                return 0;
            }

            let saveDir = lastWorldbookDirPath.value;
            if (!saveDir) {
                addLog('请选择世界书保存目录以完成落盘...', 'warning');
                saveDir = await window.electronAPI.selectGenericFolder();
                if (saveDir) lastWorldbookDirPath.value = saveDir;
            }
            if (!saveDir) {
                addLog('用户取消选择目录，未能完成落盘。', 'warning');
                return 0;
            }

            let synced = 0;
            for (const wb of pending) {
                const plainData = JSON.parse(JSON.stringify(wb.data || {}));
                const safeFileName = (wb.name && wb.name.toLowerCase().endsWith('.json'))
                    ? wb.name
                    : `${(wb.name || 'worldbook').replace(/[\\/:*?"<>|]/g, '_')}.json`;
                const filePath = `${saveDir.replace(/[\\/]+$/, '')}\\${safeFileName}`;
                const res = await window.electronAPI.createWorldbook({ filePath, data: plainData });
                if (res && res.success) {
                    wb.path = filePath;
                    synced++;
                    addLog(`💾 已落盘: ${safeFileName}`, 'success');
                } else {
                    addLog(`⚠️ 落盘失败: ${(res && res.error) || '未知错误'} (${safeFileName})`, 'warning');
                }
            }
            if (synced > 0) {
                nativeAlert(`已将 ${synced} 本内存中的世界书保存到本地磁盘！`, 'info');
            }
            return synced;
        };

        // 🌍 网址导入世界书已拆分为组合式函数 useWorldbooks（见下文 setup 尾部调用）

        // 🌍 世界书重命名/文件夹导入/删除/克隆/右键菜单已拆分为组合式函数 useWorldbooks（见下文 setup 尾部调用）

        // 🌍 世界书文件夹导入/删除/克隆/右键菜单方法已拆分为组合式函数 useWorldbooks（见下文 setup 尾部调用）

        // 物理保存当前世界书
        const saveActiveWorldbook = async () => {
            if (!activeWorldbook.value) return;
            const wb = activeWorldbook.value;
            addLog(`准备落盘保存世界书: ${wb.name}...`);

            // 脱离 Proxy 代理进行序列化（避免 IPC "An object could not be cloned"），
            // 并剔除 IDE 展示字段 _collapsed 与前端临时 UID（酒馆原生世界书格式无 uid 字段）防污染
            const plainData = JSON.parse(JSON.stringify(wb.data));
            if (Array.isArray(plainData.entries)) {
                plainData.entries.forEach(e => {
                    if (!e) return;
                    if (e._collapsed !== undefined) delete e._collapsed;
                    if (e.uid !== undefined) delete e.uid;
                });
            }

            // 【修复】内存态世界书（path 为空，如网址导入后未落盘）先补齐物理文件再保存
            if (!wb.path) {
                await syncWorldbooksToDisk();
                if (!wb.path) {
                    addLog(`❌ 保存失败: 该书仍停留在内存，请先点击工具栏「💾 落盘」`, 'error');
                    nativeAlert(`世界书保存失败：该书仍在内存中，请先点击世界书工具栏的「💾 落盘」按钮，或重新导入时选择保存目录。`, 'error');
                    return;
                }
            }

            const res = await window.electronAPI.saveWorldbook({
                filePath: wb.path,
                data: plainData
            });

            if (res.success) {
                addLog(`✅ 保存成功: ${activeWorldbook.value.name}`, 'success');
                nativeAlert('世界书物理落盘保存成功！', 'info');
            } else {
                addLog(`❌ 保存失败: ${res.error}`, 'error');
                nativeAlert(`世界书保存失败: ${res.error}`, 'error');
            }
        };

        // 提供独立的世界书本地导出功能（方便开发测试时脱离环境发给别人；导出前剔除 _collapsed 防污染）
        const exportActiveWorldbook = () => {
            if (!activeWorldbook.value) return;
            const plainData = JSON.parse(JSON.stringify(activeWorldbook.value.data));
            if (Array.isArray(plainData.entries)) {
                plainData.entries.forEach(e => {
                    if (!e) return;
                    if (e._collapsed !== undefined) delete e._collapsed;
                    if (e.uid !== undefined) delete e.uid;
                });
            }
            const blob = new Blob([JSON.stringify(plainData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = activeWorldbook.value.name || 'worldbook_export.json';
            a.click();
            URL.revokeObjectURL(url);
            addLog(`已触发本地独立导出: ${a.download}`);
        };

        // ✂️ 轻量级世界书拆分引擎 (基于当前搜索结果/过滤词条)
        const exportFilteredWorldbook = () => {
            if (!activeWorldbook.value) return;

            const currentEntries = filteredWorldbookEntries.value;
            if (!currentEntries || currentEntries.length === 0) {
                nativeAlert('当前没有可导出的词条！', 'warning');
                return;
            }

            // 组装新世界书的 JSON 结构
            const suffix = entrySearchQuery.value ? `_${entrySearchQuery.value.trim()}篇` : '_完整导出';
            const newWbName = (activeWorldbook.value.data.name || '拆分世界书') + suffix;

            // 清洗 UI 字段（剥离 _ 前缀临时字段、前端临时 UID 与 Vue Proxy）
            const cleanEntries = JSON.parse(JSON.stringify(currentEntries, (key, val) => (key.startsWith('_') || key === 'uid') ? undefined : val));

            const exportData = {
                name: newWbName,
                description: `这是从原版世界书拆分出的子集。包含 ${cleanEntries.length} 个词条。`,
                entries: cleanEntries
            };

            // 触发浏览器下载
            const blob = new Blob([JSON.stringify(exportData, null, 4)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${newWbName}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            addLog(`✂️ 成功拆分并导出世界书: ${newWbName}.json`, 'success');
        };

        // 智能保存：世界书模式下保存世界书，角色卡模式下保存当前卡片（文件菜单共用入口）
        const saveCurrentAsset = async () => {
            // 【修复】严格隔离双模式保存上下文，杜绝跨模式幽灵误保存
            if (appMode.value === 'worldbooks') {
                if (activeWorldbook.value) return saveActiveWorldbook();
                return nativeAlert('当前没有打开的世界书。', 'warning');
            }
            if (cardData.value) return saveToLocalDisk();
            return nativeAlert('当前没有打开的角色卡。', 'warning');
        };

        // 📚 世界书词条深度编辑（Entry IDE）已拆分为组合式函数 useWorldbookEntries（见下文 setup 尾部调用）

        // =========================================================
        // 🎛️ 角色卡内嵌世界书（Character Book）细化操作
        // 针对 data.character_book.entries（V2 字段 keys/secondary_keys），
        // 与上方「独立世界书 IDE」的 activeWorldbook（V3 字段 key/keysecondary）区分
        // =========================================================
        const characterWorldbookSearchQuery = ref('');   // 词条关键字搜索（角色卡世界书 tab 专用）

        // 确保角色卡存在 character_book.entries，返回该数组（V2/V3 的 data 内，或 V1 顶层）
        const ensureCharacterBookEntries = () => {
            if (!cardData.value) return null;
            const target = safeData.value;
            if (!target.character_book || typeof target.character_book !== 'object') {
                target.character_book = { entries: [] };
            }
            if (!Array.isArray(target.character_book.entries)) {
                target.character_book.entries = [];
            }
            return target.character_book.entries;
        };

        // =========================================================
        // 📥 从世界书库导入词条到角色卡（与「📤 提取为世界书」反向对称）
        // 复用 WbImportModal 弹窗 UI；字段转换：库（key/keysecondary/order）→ 内嵌（keys/secondary_keys/insertion_order）
        // =========================================================
        const showCardWbImportModal = ref(false);   // 导入弹窗显隐
        const cardWbImportSource = ref(null);       // 当前选中的源世界书
        const cardWbImportCandidates = ref([]);     // 源书词条候选（带临时 _srcUid 做勾选 key）
        const cardWbSelectedEntries = ref([]);      // 用户勾选的词条 _srcUid 集合

        const openCardWbImportModal = () => {
            if (!cardData.value) { nativeAlert('请先打开一张角色卡。', 'warning'); return; }
            if (worldbooks.value.length === 0) { nativeAlert('世界书库为空，请先在世界书模式导入世界书。', 'warning'); return; }
            cardWbImportSource.value = null;
            cardWbImportCandidates.value = [];
            cardWbSelectedEntries.value = [];
            showCardWbImportModal.value = true;
        };

        // 选中源世界书后，展开其词条候选（🛡️ 兼容字典形态 entries，与库内其他入口同一清洗口径）
        const pickCardWbImportSource = (wb) => {
            cardWbImportSource.value = wb;
            let srcEntries = (wb.data && wb.data.entries) || [];
            if (srcEntries && typeof srcEntries === 'object' && !Array.isArray(srcEntries)) {
                srcEntries = Object.values(srcEntries);
            }
            cardWbImportCandidates.value = srcEntries.map((e, i) => ({
                ...e,
                _srcIndex: i,
                _srcUid: e.uid || ('src-' + i)
            }));
            cardWbSelectedEntries.value = [];
        };

        // 确认导入：深拷贝勾选词条 → 库字段转换为内嵌字段 → 追加到 character_book.entries
        const confirmCardWbImport = () => {
            if (!cardWbImportSource.value) { nativeAlert('请先选择源世界书。', 'warning'); return; }
            if (cardWbSelectedEntries.value.length === 0) { nativeAlert('请至少勾选一个词条。', 'warning'); return; }
            const targetEntries = ensureCharacterBookEntries();
            if (!targetEntries) { nativeAlert('请先打开一张角色卡。', 'warning'); return; }

            let count = 0;
            cardWbImportCandidates.value.forEach(c => {
                if (!cardWbSelectedEntries.value.includes(c._srcUid)) return;
                // 深拷贝并剔除 _ 前缀临时字段（_collapsed/_srcIndex/_srcUid），重新生成前端 uid
                const clean = JSON.parse(JSON.stringify(c, (k, v) => k.startsWith('_') ? undefined : v));
                clean.uid = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                clean._collapsed = false;
                targetEntries.push(clean);
                count++;
            });

            showCardWbImportModal.value = false;
            refreshCardData();
            const srcName = (cardWbImportSource.value.data && cardWbImportSource.value.data.name) || cardWbImportSource.value.name;
            nativeAlert(`📥 已从《${srcName}》导入 ${count} 个词条到角色卡内嵌世界书。`, 'info');
            addLog(`📥 从世界书库《${srcName}》导入 ${count} 个词条`, 'success');
        };

        // 搜索过滤后的角色卡世界书词条（触发词/次级词/备注/正文 全字段匹配）
        const filteredCharacterWorldbookEntries = computed(() => {
            const q = characterWorldbookSearchQuery.value.trim().toLowerCase();
            const list = worldbookEntries.value;
            if (!q) return list;
            return list.filter(entry => {
                if (!entry) return false;
                const keysStr = (Array.isArray(entry.keys) ? entry.keys.join(' ') : String(entry.keys || '')) + ' ' +
                                (Array.isArray(entry.secondary_keys) ? entry.secondary_keys.join(' ') : '');
                const text = `${entry.comment || entry.name || ''} ${entry.content || ''} ${keysStr}`.toLowerCase();
                return text.includes(q);
            });
        });

        // 新增空白词条（unshift 到最前）
        const addCharacterWorldbookEntry = () => {
            const entries = ensureCharacterBookEntries();
            if (!entries) return;
            entries.unshift({
                uid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                keys: [], secondary_keys: [], content: '', comment: '',
                constant: false, selective: false, insertion_order: 50,
                position: 1, enabled: true, order: 100
            });
            refreshCardData();
            addLog('➕ 新增了一条世界书词条', 'info');
        };

        // 删除词条（走原生 confirmDialog 确认）
        const deleteCharacterWorldbookEntry = async (entry) => {
            const entries = safeData.value.character_book?.entries;
            if (!Array.isArray(entries)) return;
            const index = entries.indexOf(toRaw(entry));   // toRaw 找回原始对象（worldbookEntries 返回的是 reactive 代理）
            if (index === -1) return;
            const ok = await confirmDialog('确定要删除这条世界书设定吗？操作不可逆！');
            if (ok) {
                entries.splice(index, 1);
                refreshCardData();
                addLog('🗑️ 删除了一条世界书词条', 'warning');
            }
        };

        // 克隆词条（在后方插入副本）
        const duplicateCharacterWorldbookEntry = (entry) => {
            const entries = safeData.value.character_book?.entries;
            if (!Array.isArray(entries)) return;
            const index = entries.indexOf(toRaw(entry));
            if (index === -1) return;
            const cloned = JSON.parse(JSON.stringify(entry));
            cloned.uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            cloned.comment = (cloned.comment || cloned.name || '词条') + ' (副本)';
            entries.splice(index + 1, 0, cloned);
            refreshCardData();
            addLog('📋 复制了一条世界书词条', 'info');
        };

        // 上移/下移（dir = -1 上移，+1 下移）
        const moveCharacterWorldbookEntry = (entry, dir) => {
            const entries = safeData.value.character_book?.entries;
            if (!Array.isArray(entries)) return;
            const index = entries.indexOf(toRaw(entry));
            if (index === -1) return;
            const target = index + dir;
            if (target < 0 || target >= entries.length) return;
            const [item] = entries.splice(index, 1);
            entries.splice(target, 0, item);
            refreshCardData();
        };

        // 往词条 key 数组追加一个触发词（field: 'keys' | 'secondary_keys'）
        const addEntryKey = (entry, value, field = 'keys') => {
            if (!entry || !field) return;
            const v = String(value || '').trim().replace(/,$/, '').trim();
            if (!v) return;
            if (!Array.isArray(entry[field])) entry[field] = [];
            if (!entry[field].includes(v)) entry[field].push(v);
            refreshCardData();
        };

        // 从词条 key 数组移除一个触发词
        const removeEntryKey = (entry, value, field = 'keys') => {
            if (!entry || !field || !Array.isArray(entry[field])) return;
            entry[field] = entry[field].filter(k => k !== value);
            refreshCardData();
        };

        // 触发词输入框的回车/逗号处理（标签化输入）
        const handleEntryKeyInput = (entry, event, field = 'keys') => {
            if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                addEntryKey(entry, event.target.value, field);
                event.target.value = '';
            }
        };

        // 写回 comment（兼容旧卡仅有 name 字段）
        const updateEntryComment = (entry, value) => {
            if (!entry) return;
            entry.comment = value;
            refreshCardData();
        };

        // 🔍 角色卡查重弹窗状态与方法已拆分为组合式函数 useDedupe（见下文 setup 尾部调用）

        // 计算单张卡片的设定丰度（与 cardTokenStats 口径对齐：叠加描述/首句/示例/性格/场景 + 世界书正文与触发词）
        // 🚀 v1.8.5 性能修复：WeakMap 结果缓存（key = 卡片 data 对象引用）。
        //    该函数被侧栏每个列表项渲染（itemTokenCount）+ tokens 排序比较器调用，
        //    旧版无缓存：千卡库一次 tokens 排序 = O(N log N) 次全量重算（每卡正则
        //    匹配 + 世界书全条目遍历），列表每次重渲再对全部可见项重算一遍 → 输入
        //    卡顿/界面冻结主因。卡片 data 引用在库内稳定，缓存命中率极高；
        //    编辑当前卡时由 refreshCardData 精确失效（WeakMap.delete）。
        const cardTokensCache = new WeakMap();
        const estimateCardTokens = (card) => {
            const dataKey = (card && (card.data || card)) || null;
            if (dataKey && typeof dataKey === 'object') {
                const cached = cardTokensCache.get(dataKey);
                if (cached !== undefined) return cached;
            }
            const d = card.data?.data || card.data || {};
            const text = [d.description, d.first_mes, d.mes_example, d.personality, d.scenario].filter(Boolean).join('\n');
            let total = estimateTokens(text);
            // 追加世界书词条正文与触发词（与 cardTokenStats 的世界书口径保持一致）
            // 🛡️ extractBookEntries 全形态安全提取：修复 entries 字典形态 / character_book 数组形态
            //    导致的 entries.forEach 崩溃——该函数被侧栏列表每张卡的渲染（itemTokenCount）与
            //    tokens 排序调用，一旦抛错即引发「角色栏消失/空屏」，且卡在库内每次重启复发
            const book = d.character_book || (card.data && card.data.character_book) || {};
            const entries = extractBookEntries(book);
            entries.forEach(e => {
                total += estimateTokens(e.content) + estimateTokens((Array.isArray(e.key) ? e.key : []).join(', '));
            });
            if (dataKey && typeof dataKey === 'object') cardTokensCache.set(dataKey, total);
            return total;
        };

        // 🔍 角色卡查重扫描与清理方法已拆分为组合式函数 useDedupe（见下文 setup 尾部调用）

        // =========================================================
        // 🌍 世界书库筛选与智能对比查重引擎
        // =========================================================
        const wbSearchQuery = ref('');         // 世界书侧边栏搜索框
        const wbFilterType = ref('all');        // 词条数筛选: 'all' | 'empty' | 'small' | 'large'
        // 🔍 世界书查重弹窗状态与方法已拆分为组合式函数 useDedupe（见下文 setup 尾部调用）

        // =========================================================
        // 📁 世界书库：分组功能（Set 动态搜集 + localStorage 持久化）
        // =========================================================
        const currentWbCategory = ref('全部'); // 当前选中的分组

        // 分组持久化映射：key(path||name) -> 分类名（重扫/重启后自动恢复）
        const loadWbCategoriesMap = () => {
            try { return JSON.parse(localStorage.getItem('jsTavern_wbCategories') || '{}'); } catch (e) { return {}; }
        };
        const wbCategoryMap = ref(loadWbCategoriesMap());
        const saveWbCategoriesMap = () => {
            try { localStorage.setItem('jsTavern_wbCategories', JSON.stringify(wbCategoryMap.value)); } catch (e) { /* 忽略 */ }
        };

        // ================= [ UI 状态统一收口到 app_config.json ] =================
        // 生产 app:// 下 localStorage 不持久，这些 UI 偏好变化时在写 localStorage 之外，
        // 再触发一次 syncConfigToDisk 写入 app_config.json（localCategoryMap 已由自身 watch 收口，此处去重）。
        // 与此处建立集中 watch：所有相关 ref 已声明完毕（最后一个为 wbCategoryMap），
        // 回调里的 syncConfigToDisk 已内置 isRestoringConfig guard，恢复期触发的写盘会被自动拦截，无需 immediate。
        watch(
            [theme, appSettings, sanitizeImportedTags, snapshotConfig, sidebarWidth, viewMode, isCompactMode, sortBy, systemPromptPresets, lastWorldbookDirPath, lastPresetDirPath, wbCategoryMap, cardImportTimes],
            // 🚀 v1.8.5 性能修复：改走 500ms 防抖落盘。旧版直接调 syncConfigToDisk（全量
            //    序列化 appSettings/cardOverlays/wbCategoryMap + 加密 IPC + 同步写盘），
            //    连续 UI 微调（拖侧栏宽度/切主题等）每次都全量写盘，千卡库 overlays 体积
            //    大时拖动全程卡顿。防抖版已有 beforeunload 冲刷兜底，不丢最后一次变更。
            () => syncConfigToDiskDebounced(),
            { deep: true }
        );

        // 📁 世界书分组（获取/列表/修改/筛选）已拆分为组合式函数 useWorldbooks（见下文 setup 尾部调用）

        // 🔍 世界书查重扫描与清理方法已拆分为组合式函数 useDedupe（见下文 setup 尾部调用）

        // 🔍 双屏差异比对器（Diff Inspector）已拆分为组合式函数 useDedupe（见下文 setup 尾部调用）

        // =========================================================
        // 🌐 世界书可视化关系图谱 (ECharts Graph) —— v2 性能与功能升级
        // - 索引化构建：key→词条 倒排索引 + 权重聚合，替代旧版 O(n²) 双循环逐对
        //   keys.some(content.includes)（300+ 词条大书卡顿主因）；过滤 <2 字符噪音 key；
        // - 构建/渲染分离：打开时构建一次全量缓存，过滤/搜索/阈值只做轻量重渲；
        // - 新增：布局切换 / 词条类型过滤(常驻/触发/禁用) / 搜索高亮 / 连线权重阈值 /
        //   孤立词条统计 / PNG 导出 / resize 自适应 / 关闭时销毁实例防泄漏；
        // - 大书同步构建会阻塞主线程 → 先绘制弹窗与 loading 遮罩，再后台构建
        // =========================================================
        const showWbGraphModal = ref(false);
        const wbGraphBuilding = ref(false);
        let wbChartInstance = null;
        let wbGraphNodesCache = [];   // 全量节点（打开时构建一次）
        let wbGraphLinksCache = [];   // 全量连线（打开时构建一次，含 weight）
        let wbGraphSearchTimer = null;

        const wbGraphLayout = ref('force');
        const wbGraphSearch = ref('');
        const wbGraphMinWeight = ref(1);
        const wbGraphFilters = reactive({ constant: true, triggered: true, disabled: false });
        const wbGraphStats = reactive({ nodes: 0, links: 0, orphans: 0 });

        const handleWbGraphResize = () => {
            if (wbChartInstance) wbChartInstance.resize();
        };

        // 构建全量节点与连线（仅打开时执行一次；分批让出主线程，loading 转圈不冻结）
        const buildWbGraphData = async () => {
            const entries = activeWorldbook.value.data.entries || [];
            const nodes = [];

            // 构建节点 —— 300+ 节点需调小球体（按内容长度微调区分大小，范围 10-22）
            entries.forEach((e, idx) => {
                const label = e.comment || (Array.isArray(e.key) ? e.key.join('/') : e.key) || `词条 #${idx + 1}`;
                nodes.push({
                    id: String(e.uid || idx),
                    name: label,
                    symbolSize: Math.max(10, Math.min(22, 8 + String(e.content || '').length / 40)),
                    entryIndex: idx,
                    isConstant: !!e.constant,
                    isDisabled: e.enabled === false,
                    itemStyle: {
                        color: e.enabled === false ? '#71717a' : (e.constant ? '#6366f1' : '#d97706')
                    }
                });
            });

            // 倒排索引：触发词 → 目标词条列表（去重 + 过滤 <2 字符的噪音 key，
            // 单字 key 如「你」会造成连线风暴且多为误命中）
            const keyIndex = new Map();
            entries.forEach((e, idx) => {
                const keys = Array.isArray(e.key) ? e.key : (e.key ? [e.key] : []);
                keys.forEach(k => {
                    const kk = String(k || '').trim().toLowerCase();
                    if (kk.length < 2) return;
                    if (!keyIndex.has(kk)) keyIndex.set(kk, new Set());
                    keyIndex.get(kk).add(String(e.uid || idx));
                });
            });

            // 权重聚合：同一 (source→target) 的多个 key 命中合并为一条线，线宽随权重增长
            // 🔧 分批处理：每批之间让出主线程一帧——旧版一次性同步聚合曾把 UI 冻结数秒，
            //    分批后 loading 转圈（CSS 合成器动画）保持流畅
            // 🔧 bigram 预过滤：key 命中判断从「每个 key 全文 includes」降为 O(1) Set 查询——
            //    只有 key 的首两字确实相邻出现在正文中时才回退全文校验。
            //    大书(2000 词条 × 5000 key)从 ~千万次全文扫描降至 ~千万次 Set 命中，提速 10-100 倍
            const getBigrams = (content) => {
                const s = new Set();
                for (let i = 0; i + 1 < content.length; i++) s.add(content.slice(i, i + 2));
                return s;
            };
            const linkAgg = new Map();
            const CHUNK = 80;
            for (let base = 0; base < entries.length; base += CHUNK) {
                const end = Math.min(base + CHUNK, entries.length);
                for (let idxA = base; idxA < end; idxA++) {
                    const eA = entries[idxA];
                    const content = String(eA.content || '').toLowerCase();
                    if (!content) continue;
                    const bg = getBigrams(content);
                    const srcId = String(eA.uid || idxA);
                    keyIndex.forEach((targetIds, kk) => {
                        if (!bg.has(kk.slice(0, 2))) return;          // 首二字未相邻出现 → 必不命中，跳过
                        if (kk.length > 2 && !content.includes(kk)) return; // 长词回退全文精确校验
                        targetIds.forEach(tgtId => {
                            if (tgtId === srcId) return;
                            const key = srcId + '→' + tgtId;
                            linkAgg.set(key, (linkAgg.get(key) || 0) + 1);
                        });
                    });
                }
                await new Promise(r => setTimeout(r, 0)); // 让出主线程
            }

            // 🔧 连线预算：极端常见的通用词会产生数万条连线，直接卡死力导向模拟器；
            // 按权重降序保留前 4000 条（权重=命中触发词数，泛化连线先被裁掉）
            let aggList = Array.from(linkAgg, ([key, w]) => ({ key, w }));
            const WB_MAX_LINKS = 4000;
            if (aggList.length > WB_MAX_LINKS) {
                aggList.sort((x, y) => y.w - x.w);
                aggList = aggList.slice(0, WB_MAX_LINKS);
            }

            const links = aggList.map(({ key, w }) => {
                const sep = key.indexOf('→');
                return {
                    source: key.slice(0, sep),
                    target: key.slice(sep + 1),
                    weight: w,
                    lineStyle: { curveness: 0.1, opacity: 0.5, width: Math.min(1 + w * 0.4, 4) }
                };
            });

            wbGraphNodesCache = nodes;
            wbGraphLinksCache = links;
        };

        // 🔧 捕获世界书图谱当前布局坐标（半内部 API，失败静默降级）
        // 作为下次渲染的位置种子：过滤/搜索/阈值切换后整图不再重新洗牌
        const captureWbGraphPositions = () => {
            const pos = new Map();
            try {
                const model = wbChartInstance.getModel && wbChartInstance.getModel();
                const seriesModel = model && model.getSeriesByIndex && model.getSeriesByIndex(0);
                const graph = seriesModel && seriesModel.getGraph && seriesModel.getGraph();
                if (graph && graph.eachNode) {
                    graph.eachNode((node) => {
                        const layout = node.getLayout && node.getLayout();
                        if (layout && layout.length >= 2) pos.set(String(node.id), [layout[0], layout[1]]);
                    });
                }
            } catch (e) { return new Map(); }
            return pos;
        };

        // 轻量重渲：应用 类型过滤 / 权重阈值 / 搜索高亮 / 布局（不重建缓存）
        const renderWbGraph = () => {
            if (!wbChartInstance) return;

            const seedPos = wbGraphLayout.value === 'force' ? captureWbGraphPositions() : null;
            const kw = wbGraphSearch.value.trim().toLowerCase();
            const visibleNodes = [];
            const visibleIds = new Set();

            wbGraphNodesCache.forEach(n => {
                const passFilter = (n.isDisabled && wbGraphFilters.disabled) ||
                                   (!n.isDisabled && n.isConstant && wbGraphFilters.constant) ||
                                   (!n.isDisabled && !n.isConstant && wbGraphFilters.triggered);
                if (!passFilter) return;
                const hit = !kw || n.name.toLowerCase().includes(kw);
                const node = {
                    ...n,
                    itemStyle: { ...n.itemStyle, opacity: kw ? (hit ? 1 : 0.15) : 1 },
                    symbolSize: hit && kw ? Math.min(n.symbolSize * 1.5, 36) : n.symbolSize,
                    label: { show: !!kw && hit, position: 'right' }
                };
                if (seedPos) {
                    const p = seedPos.get(n.id);
                    if (p) { node.x = p[0]; node.y = p[1]; }
                }
                visibleNodes.push(node);
                visibleIds.add(n.id);
            });

            const visibleLinks = wbGraphLinksCache.filter(l =>
                l.weight >= wbGraphMinWeight.value && visibleIds.has(l.source) && visibleIds.has(l.target)
            );

            // 统计徽标：词条 / 连线 / 孤立词条（无任何连线的词条，常为死词条线索）
            const deg = new Map();
            visibleLinks.forEach(l => {
                deg.set(l.source, (deg.get(l.source) || 0) + 1);
                deg.set(l.target, (deg.get(l.target) || 0) + 1);
            });
            wbGraphStats.nodes = visibleNodes.length;
            wbGraphStats.links = visibleLinks.length;
            wbGraphStats.orphans = visibleNodes.reduce((acc, n) => acc + (deg.get(n.id) ? 0 : 1), 0);

            // 🔧 标签封顶：宽泛搜索词可能命中数百词条，全开标签会每帧渲染数百文本掉帧；
            // 仅保留度数 Top80 的命中标签（聚光灯悬浮时仍能看到任意节点名）
            if (kw) {
                const hits = visibleNodes.filter(n => n.label && n.label.show);
                if (hits.length > 80) {
                    hits.sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0));
                    hits.forEach((hn, i) => { if (i >= 80) hn.label.show = false; });
                }
            }

            // 规模自适应物理参数：大书收缩斥力 + 高摩擦快速收敛
            // ⚠️ 不设 layoutAnimation:false —— 同步跑完全部物理迭代会冻结 UI 数秒（v2 回归，已移除）
            const n = visibleNodes.length;
            const forceParams = n > 200
                ? { repulsion: 120, edgeLength: [15, 60], gravity: 0.15, friction: 0.8 }
                : { repulsion: 150, edgeLength: [20, 70], gravity: 0.15, friction: 0.6 };

            const option = {
                backgroundColor: 'transparent',
                tooltip: {
                    formatter: (params) => {
                        if (params.dataType === 'node') {
                            return `<b>${params.name}</b><br/>关联度: ${deg.get(params.data.id) || 0} 条连线<br/>👉 点击节点可跳转直达词条`;
                        }
                        return `<b>关联引用</b>: ${params.data.source} ➔ ${params.data.target}<br/>命中 ${params.data.weight} 个触发词`;
                    }
                },
                series: [{
                    type: 'graph',
                    layout: wbGraphLayout.value,
                    data: visibleNodes,
                    links: visibleLinks,
                    roam: true,        // 滚轮缩放 + 鼠标平移
                    draggable: true,   // 允许单独拖拽球体

                    symbolSize: 12,
                    label: { show: false, position: 'right' },

                    // ✨ 聚光灯效应：悬浮只高亮当前节点与邻居，其余全部变暗沉寂
                    emphasis: {
                        focus: 'adjacency',
                        lineStyle: { width: 3 },
                        label: {
                            show: true,
                            fontSize: 13,
                            color: '#34d399',
                            backgroundColor: 'rgba(0, 0, 0, 0.7)',
                            padding: [4, 8],
                            borderRadius: 4
                        }
                    },

                    force: forceParams,
                    edgeSymbol: ['none', 'arrow'],
                    edgeSymbolSize: [4, 7],
                    lineStyle: { color: '#a1a1aa', width: 1.2 }
                }]
            };

            wbChartInstance.setOption(option, true);
        };

        // 绑定节点点击事件：关闭图谱，展开并平滑滚动定位 + 高亮闪烁目标词条
        const bindWbGraphEvents = () => {
            if (!wbChartInstance) return;
            wbChartInstance.off('click');
            wbChartInstance.on('click', (params) => {
                if (params.dataType === 'node' && params.data.entryIndex !== undefined) {
                    closeWbGraphModal();
                    const targetEntry = activeWorldbook.value.data.entries[params.data.entryIndex];
                    if (!targetEntry) return;
                    targetEntry._collapsed = false; // 自动展开

                    // ✅ 增强：平滑滚动到词条卡片并高亮闪烁
                    // 🔧 修复：锚点须与 EditorPanel 渲染 id 同源 —— 独立世界书 IDE 的 DOM id
                    //    是 'wb-entry-' + ensureUid(entry)（uid 字段体系），
                    //    旧代码误用 getEntryUid（内嵌世界书的 WeakMap 计数器体系，'entry-N' 样式），
                    //    两套体系永不相等 → getElementById 永远落空，图谱点击定位静默失效。
                    nextTick(() => {
                        const dom = document.getElementById('wb-entry-' + ensureUid(targetEntry));
                        if (dom) {
                            dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            dom.classList.add('ring-2', 'ring-emerald-500', 'shadow-[0_0_24px_rgba(16,185,129,0.35)]');
                            setTimeout(() => {
                                dom.classList.remove('ring-2', 'ring-emerald-500', 'shadow-[0_0_24px_rgba(16,185,129,0.35)]');
                            }, 1800);
                        }
                    });
                    addLog(`📍 通过图谱定位到词条: #${params.data.entryIndex + 1}`, 'info');
                }
            });
        };

        const openWbGraphModal = () => {
            if (!activeWorldbook.value || !activeWorldbook.value.data || !activeWorldbook.value.data.entries || activeWorldbook.value.data.entries.length === 0) {
                nativeAlert('当前世界书没有词条，无法生成关系图谱！', 'warning');
                return;
            }
            showWbGraphModal.value = true;
            wbGraphBuilding.value = true;
            window.addEventListener('resize', handleWbGraphResize);

            // 待 DOM 挂载后初始化 ECharts
            nextTick(() => {
                const chartDom = document.getElementById('wb-graph-container');
                if (!chartDom) { wbGraphBuilding.value = false; return; }

                if (wbChartInstance) wbChartInstance.dispose();
                wbChartInstance = echarts.init(chartDom, theme.value === 'light' ? 'light' : 'dark');
                bindWbGraphEvents();

                // 大书同步构建会阻塞主线程：先让弹窗与 loading 遮罩完成绘制，再分批后台构建
                setTimeout(async () => {
                    try {
                        await buildWbGraphData();
                        renderWbGraph();
                    } catch (e) {
                        console.error('世界书图谱构建失败:', e);
                        nativeAlert('图谱构建失败: ' + e.message, 'error');
                        showWbGraphModal.value = false;
                    } finally {
                        wbGraphBuilding.value = false;
                    }
                }, 50);
            });
        };

        const closeWbGraphModal = () => {
            showWbGraphModal.value = false;
            window.removeEventListener('resize', handleWbGraphResize);
            // 延迟销毁：给过渡动画时间，防 Canvas 上下文未释放导致低配机内存溢出
            if (wbChartInstance) {
                const inst = wbChartInstance;
                wbChartInstance = null;
                setTimeout(() => {
                    if (inst && !inst.isDisposed()) inst.dispose();
                }, 300);
            }
        };

        const updateWbGraphLayout = (mode) => {
            wbGraphLayout.value = mode;
            renderWbGraph();
        };

        // 搜索防抖：停止输入 300ms 后才重渲（过滤走缓存，成本极低）
        watch(wbGraphSearch, () => {
            clearTimeout(wbGraphSearchTimer);
            wbGraphSearchTimer = setTimeout(() => renderWbGraph(), 300);
        });

        // 📷 导出当前世界书图谱为 PNG（2x 分辨率，跟随主题底色）
        const exportWbGraph = () => {
            if (!wbChartInstance) return;
            try {
                const url = wbChartInstance.getDataURL({ pixelRatio: 2, backgroundColor: theme.value === 'light' ? '#ffffff' : '#09090b' });
                const bookName = ((activeWorldbook.value && activeWorldbook.value.name) || 'worldbook').replace(/\.json$/i, '');
                const a = document.createElement('a');
                a.href = url;
                a.download = `世界书图谱_${bookName}_${new Date().toISOString().slice(0, 10)}.png`;
                a.click();
            } catch (e) {
                nativeAlert('图谱导出失败: ' + e.message, 'error');
            }
        };

        // =========================================================
        // 🔗 多书一键合并引擎 (Worldbook Merger)
        // =========================================================
        const showWbMergeModal = ref(false);
        const selectedWbMergePaths = ref([]);

        const openWbMergeModal = () => {
            if (worldbooks.value.length < 2) {
                nativeAlert('当前载入的世界书少于 2 本，无需合并！', 'warning');
                return;
            }
            selectedWbMergePaths.value = [];
            showWbMergeModal.value = true;
        };

        const executeWorldbookMerge = () => {
            if (selectedWbMergePaths.value.length < 2) {
                nativeAlert('请至少勾选 2 本世界书进行合并！', 'warning');
                return;
            }

            const targetWbs = worldbooks.value.filter(wb => selectedWbMergePaths.value.includes(wb.path));
            const mergedEntries = [];
            const seenMap = new Set(); // 指纹去重: Key + Content

            targetWbs.forEach(wb => {
                const entries = (wb.data && Array.isArray(wb.data.entries)) ? wb.data.entries : [];
                entries.forEach(e => {
                    if (!e || typeof e !== 'object') return; // 脏数据条目防护
                    // 【加固】key/content 可能是数字/对象等非字符串，直接 .trim() 会崩溃
                    const keysStr = String(Array.isArray(e.key) ? e.key.map(k => String(k)).join(',') : (e.key || '').trim().toLowerCase());
                    const contentStr = String(e.content || '').trim().toLowerCase();
                    const signature = `${keysStr}:::${contentStr}`;

                    if (!seenMap.has(signature)) {
                        seenMap.add(signature);
                        // 剔除 _collapsed 等临时 UI 字段
                        const cleanEntry = JSON.parse(JSON.stringify(e, (k, v) => k.startsWith('_') ? undefined : v));
                        cleanEntry.uid = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                        mergedEntries.push(cleanEntry);
                    }
                });
            });

            const mergeName = `合并世界书_${targetWbs.length}本`;
            const mergedWbData = {
                name: mergeName,
                description: `由 [${targetWbs.map(w => (w.data && w.data.name) || w.name).join(', ')}] 合并而成，包含 ${mergedEntries.length} 个词条。`,
                entries: mergedEntries
            };

            const newWbItem = {
                // 【修复】path 设为空字符串，让保存系统知道它还从未落盘，
                // 触发 syncWorldbooksToDisk 的智能落盘分配（否则假路径会让 Electron 报“原文件不存在”）
                path: '',
                name: `${mergeName}.json`,
                data: mergedWbData
            };

            worldbooks.value.unshift(newWbItem);
            activeWorldbook.value = newWbItem;
            showWbMergeModal.value = false;

            nativeAlert(`🎉 成功合并 ${targetWbs.length} 本世界书！共生成 ${mergedEntries.length} 个去重词条。`, 'info');
            addLog(`🔗 完成多书合并: ${mergeName}`, 'success');
        };

        // =========================================================
        // � 条目级合并引擎：从其他世界书按需导入词条到当前书（弹窗 → 勾选 → 确认）
        // =========================================================
        const showWbImportModal = ref(false);      // 导入弹窗显隐
        const importSourceBook = ref(null);        // 当前选中的源世界书
        const importCandidates = ref([]);          // 源书词条候选（带临时 _srcUid 做勾选 key）
        const selectedImportEntries = ref([]);     // 用户勾选的词条 _srcUid 集合

        // 可导入的源书列表（排除当前正在编辑的世界书）
        const importableSourceBooks = computed(() => {
            if (!activeWorldbook.value) return worldbooks.value;
            return worldbooks.value.filter(wb => wb.path !== activeWorldbook.value.path);
        });

        const openWbImportModal = () => {
            if (!activeWorldbook.value) {
                nativeAlert('请先打开/选中一本世界书作为合并目标。', 'warning');
                return;
            }
            importSourceBook.value = null;
            importCandidates.value = [];
            selectedImportEntries.value = [];
            showWbImportModal.value = true;
        };

        // 选中源世界书后，展开其词条候选
        const pickImportSource = (wb) => {
            importSourceBook.value = wb;
            importCandidates.value = ((wb.data && wb.data.entries) || []).map((e, i) => ({
                ...e,
                _srcIndex: i,
                _srcUid: e.uid || ('src-' + i)
            }));
            selectedImportEntries.value = [];
        };

        // 确认导入：深拷贝选中词条 → 清洗临时字段 → 追加到当前世界书
        const confirmImportEntries = () => {
            if (!importSourceBook.value) { nativeAlert('请先选择源世界书。', 'warning'); return; }
            if (selectedImportEntries.value.length === 0) {
                nativeAlert('请至少勾选一个词条。', 'warning');
                return;
            }
            const targetEntries = activeWorldbook.value.data.entries;
            if (!Array.isArray(targetEntries)) activeWorldbook.value.data.entries = [];

            let count = 0;
            importCandidates.value.forEach(c => {
                if (!selectedImportEntries.value.includes(c._srcUid)) return;
                // 深拷贝并剔除 _ 前缀临时字段（_collapsed/_srcIndex/_srcUid），重新生成前端 uid
                const clean = JSON.parse(JSON.stringify(c, (k, v) => k.startsWith('_') ? undefined : v));
                clean.uid = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                clean._collapsed = false;
                targetEntries.push(clean);
                count++;
            });

            showWbImportModal.value = false;
            nativeAlert(`🎉 成功从 [${importSourceBook.value.name}] 导入 ${count} 个词条到当前世界书！`, 'info');
            addLog(`🔀 从 ${importSourceBook.value.name} 导入 ${count} 个词条`, 'success');
        };

        // =========================================================
        // 🚀 OTA 自动更新系统（electron-updater：检测/下载/进度/安装）
        // =========================================================
        const showUpdateModal = ref(false);
        const updateInfo = ref({
            hasUpdate: false,
            currentVersion: '1.0.0',
            latestVersion: '',
            releaseNotes: '',
            downloadUrl: ''
        });
        // 更新错误信号（统一在 App 层收口，转发给 UpdateModal 重置状态，避免与子组件监听冲突）
        const updateErrorMsg = ref('');
        // 🔔 新版本角落提醒浮标：静默检测到新版时点亮右下角浮标（不弹窗打断操作）
        const showUpdateBadge = ref(false);
        // 用户点浮标 ✕ 后本次启动内不再提醒（下次启动重新静默检测）
        const dismissUpdateBadge = () => { showUpdateBadge.value = false; };
        let isManualCheck = false; // 区分手动/静默检测（静默检测到已最新时不打扰）
        let manualCheckTimer = null; // 手动检测超时保护，防止事件未到达时 isManualCheck 卡死

        // 手动检测更新（用于设置菜单里的按钮）：触发检查，结果通过事件驱动
        const checkForUpdatesManual = async () => {
            addLog('🔄 正在检查更新...', 'info');
            isManualCheck = true;
            // 60 秒超时保护：若事件始终未到达（网络异常/升级器静默失败），重置手动检测标志
            clearTimeout(manualCheckTimer);
            manualCheckTimer = setTimeout(() => { isManualCheck = false; }, 60000);
            try {
                const res = await window.electronAPI.checkUpdate();
                if (!res || !res.success) {
                    clearTimeout(manualCheckTimer);
                    isManualCheck = false;
                    // 开发模式是预期跳过，用 info 提示而非"失败"
                    if (res && /开发模式/.test(res.error || '')) {
                        nativeAlert(res.error, 'info');
                    } else {
                        nativeAlert(`更新检测失败: ${res?.error || '网络错误'}`, 'error');
                    }
                }
                // 成功：结果通过 update-available / update-not-available 事件到达
            } catch (err) {
                clearTimeout(manualCheckTimer);
                isManualCheck = false;
                nativeAlert(`更新检测失败: ${err.message || '网络错误'}`, 'error');
            }
        };

        // 后台静默检测（开机时自动调用）：有更新才弹窗，没更新不打扰
        const silentCheckForUpdates = async () => {
            if (!window.electronAPI || typeof window.electronAPI.checkUpdate !== 'function') return;
            try {
                await window.electronAPI.checkUpdate();
                // 有更新时 update-available 事件会弹窗；无更新时 update-not-available 静默忽略
            } catch (err) {
                console.warn('静默检测更新失败', err);
            }
        };

        // 绑定 OTA 更新事件（弹窗驱动）
        const setupUpdateListeners = () => {
            if (!window.electronAPI) return;
            if (typeof window.electronAPI.onUpdateAvailable === 'function') {
                window.electronAPI.onUpdateAvailable((info) => {
                    updateInfo.value = { ...(info || {}) };
                    updateErrorMsg.value = ''; // 新版本信息到达，清空上一次的错误信号
                    showUpdateBadge.value = true; // 🔔 点亮角落浮标（常驻直至处理/关闭）
                    // 手动检测：直接弹详情窗；静默检测：仅角落浮标提示，不打断当前操作
                    if (isManualCheck) {
                        isManualCheck = false;
                        showUpdateModal.value = true;
                    }
                    addLog(`🎉 发现新版本: v${(info && info.latestVersion) || ''}`, 'success');
                });
            }
            if (typeof window.electronAPI.onUpdateNotAvailable === 'function') {
                window.electronAPI.onUpdateNotAvailable((info) => {
                    showUpdateBadge.value = false; // 已是最新，撤下角落浮标
                    if (isManualCheck) {
                        isManualCheck = false;
                        nativeAlert(`当前已是最新版本 (v${(info && info.currentVersion) || ''})！`, 'info');
                    }
                });
            }
            if (typeof window.electronAPI.onUpdateError === 'function') {
                window.electronAPI.onUpdateError((err) => {
                    // 统一错误收口：清除手动检测标志、转发给弹窗重置状态
                    clearTimeout(manualCheckTimer);
                    isManualCheck = false;
                    updateErrorMsg.value = String(err || '未知错误');
                    if (showUpdateModal.value) {
                        nativeAlert(`更新失败: ${String(err || '')}`, 'error');
                    }
                });
            }
        };
        setupUpdateListeners();

        // 打开外部链接（跳转系统浏览器）
        const openExternalUrl = (url) => {
            if (!url) return;
            window.electronAPI.openExternal(url);
        };

        // 🛡️ 统一配置持久化中枢：组合式函数注入（收集→加密→原子落盘 + 防抖 + 恢复期禁写 + beforeunload 冲刷）
        // ⚠️ 调用时序：必须晚于全部被收集 ref（最晚 wbCategoryMap）的定义；
        //    必须早于 useCardCrud / useChat / useTags / useCardGroups 等注入 syncConfigToDisk 的消费方；
        //    App.vue 内各 watch 回调引用返回的 const（运行时执行，无 immediate 注册），闭包安全。
        // ⚠️ isRestoringConfig 已 ref 化：onMounted 恢复期赋值须用 .value。
        const {
            isRestoringConfig, syncConfigToDisk, syncConfigToDiskDebounced, saveUiSettingsToDisk
        } = useConfigPersistence({
            appConfig,
            tagLangMode, customCategories, removedDefaultKeys, systemCommonTags,
            autoTagRules, customKeywords,
            apiEndpoint, apiKey, apiModel, apiType,
            theme, appSettings, sanitizeImportedTags, snapshotConfig, localCategoryMap,
            sidebarWidth, viewMode, isCompactMode, sortBy,
            systemPromptPresets, lastWorldbookDirPath, lastPresetDirPath, wbCategoryMap,
            cardImportTimes
        });

        // �️ 自动打标规则表自动持久化保险（v2.1）：任何修改（保存/恢复默认）都自动落盘，
        //    不依赖按钮显式调用；syncConfigToDisk 内部已有 isRestoringConfig 闸门防启动期误写。
        //    ⚠️ 必须放在 useConfigPersistence 之后（引用其返回的 syncConfigToDiskDebounced，闭包安全）。
        watch(autoTagRules, () => { syncConfigToDiskDebounced(); }, { deep: true });

        // �🌍 角色卡内嵌世界书编辑：组合式函数注入（条目派生/uid/折叠展开/触发词工具）
        // ⚠️ 调用时序：必须晚于 cardTokensCache 的定义（updateEntryKeys 运行时引用）；
        //    必须早于 useGraph（注入 worldbookExpanded）。引用方经解构同名 const，零改动。
        const {
            getEntryUid, worldbookEntries,
            worldbookExpanded, toggleWorldbookEntry, expandAllWorldbook, collapseAllWorldbook,
            getKeysString, updateEntryKeys
        } = useEmbeddedWorldbook({ cardData, safeData, cardTokensCache });

        // 📊 渲染预览器（美化/状态栏）：组合式函数注入（渲染型脚本识别 + 正则模拟替换 + DOMPurify 安全预览
        //    + 外链 GUI 沙箱 iframe + 候选数据源扫描 + 内置模板注入）
        // ⚠️ 调用时序：依赖正则域（regexScripts/ensureRegexScriptsArray/getRegexUid，定义于 setup 早期）、
        //    refreshCardData/safeData 与 worldbookEntries（useEmbeddedWorldbook 已在前方注入）及
        //    ensureCharacterBookEntries（角色卡内嵌世界书域，定义于 setup 中部），均早于此处；
        //    chatHistory 经 getter 箭头延迟绑定（useChat 调用时序晚于本函数）。
        const {
            statusbarInput, statusbarViewMode, resetStatusbarDemo,
            statusbarTemplateMeta, statusbarPromptMeta,
            statusbarTemplates, expandedTemplateUid, toggleTemplateCard, fragmentScriptCount,
            showStatusDataPanel, statusDataCandidates, importStatusData, importAllStatusData,
            renderableScripts, toggleStatusbarScript, isScriptEnabled,
            appliedResult, previewHtml, loaderUrls, injectStatusbarTemplate, injectStatusbarPrompt
        } = useStatusbarPreview({
            regexScripts, ensureRegexScriptsArray, getRegexUid, refreshCardData, safeData,
            worldbookEntries, ensureCharacterBookEntries,
            // 🔧 getChatHistory 须返回消息数组（chatHistory 为 ref，取值须 .value；延迟绑定避免 TDZ）
            getChatHistory: () => chatHistory.value,
            addLog, nativeAlert, confirmDialog
        });

        // 📸 历史快照：组合式函数注入（快照配置由 App.vue 顶层持有）
        const {
            showSnapshotModal, snapshotList, snapshotCardName, snapshotCardPath,
            openSnapshotModal, restoreSnapshot, openSnapshotFolder, closeSnapshotModal, deleteSnapshot,
            cleanAllSnapshots, cleanOrphanSnapshots, saveSnapshotSettings, triggerManualSnapshot
        } = useSnapshots({ snapshotConfig, library, cardData, currentFolderPath, nativeAlert, confirmDialog, addLog, showToast, refreshCardData });

        // 🃏 卡片 CRUD：组合式函数注入（导入入库/删除回收/持久化保存/导出重命名，从 App.vue 拆分）
        // ⚠️ 调用时序约束：
        //   - 必须晚于 syncConfigToDisk 系列与 reset/openFromLibrary/appPrompt/safeData 的定义（依赖注入）；
        //   - 必须早于 useDiskScan / useCardGroups / useBatch / useTags（它们注入 parseAndAddCard /
        //     processElectronFiles / persistCardUpdate / persistCardCategory 等）；
        //   - cleanupEmptyCategories 来自 useCardGroups（后调用），经箭头包装延迟绑定 ——
        //     箭头函数体运行时才求值（deleteCardItem 仅在用户交互时执行），无 TDZ。
        const {
            persistCardCategory, persistCardUpdate, deleteCardOverlays,
            parseAndAddCard, processElectronFiles, flushDeferredAutoTagSaves,
            handleDrop, importCards, downloadCardFromUrl,
            deleteCardItem, deleteCard,
            exportCard, renameCard
        } = useCardCrud({
            // 共享状态
            library, cardData, currentFolderPath, appConfig,
            customCategories, allCategories, isCategoryKnown,
            importedConfig, localCategoryMap, sanitizeImportedTags,
            autoTagRules: compiledAutoTagRules,
            isDragging, dragCounter, importFileInput,
            // 横切服务
            nativeAlert, showToast, appPrompt, safeData,
            // 配置中枢
            syncConfigToDisk, syncConfigToDiskDebounced,
            // 卡片导入时间映射（「导入时间」排序数据源）
            cardImportTimes,
            // 跨域回调（UI 域 / 分组域）
            reset, openFromLibrary,
            cleanupEmptyCategories: (...args) => cleanupEmptyCategories(...args)
        });

        // 💽 磁盘卡片扫描：组合式函数注入（共享创库基础设施 parseAndAddCard/processElectronFiles 与共享状态保留在 App.vue）
        const {
            isScanningDisk, diskScanProgress, useSizeFilter, showDiskScanModal,
            runDiskScan, handleScanImported, selectFixedDirectory, refreshLibrary
        } = useDiskScan({ library, currentFolderPath, cardData, customCategories, appMode, nativeAlert, showToast, isCategoryKnown, openFromLibrary, parseAndAddCard, processElectronFiles });

        // 🔎 超级搜索引擎：组合式函数注入（共享状态 library/currentCategoryKey/allCategories/sortBy/currentPage/itemsPerPage/lastSelectedIndex 保留在 App.vue）
        const {
            searchQueryInput, searchQuery,
            filteredLibrary, totalPages, paginatedLibrary,
            changePage
        } = useSearch({ library, currentCategoryKey, allCategories, sortBy, currentPage, itemsPerPage, lastSelectedIndex, estimateCardTokens });

        // 🚀 性能优化：搜索索引构建与 Token 缓存预热（异步分片，不阻塞 UI）
        // 监听 library 变化，分片异步构建索引（每 50 张卡 yield 一次主线程）
        let buildTaskId = 0;
        let pendingRebuild = false;
        const rebuildSearchIndex = (newLibrary) => {
            if (!newLibrary || newLibrary.length === 0) {
                searchIndex.clear();
                tokenCache.clear();
                return;
            }
            const taskId = ++buildTaskId;
            setTimeout(async () => {
                try {
                    // 异步分片构建索引（🚀 v2.2 提速：分片 50 → 100，万卡索引构建更快完成）
                    const stats = await searchIndex.buildAsync(newLibrary, extractCardSearchableText, extractCardTags, 100);
                    if (taskId !== buildTaskId) return; // 被新的 watch 触发取消
                    console.log('⚡ 搜索索引构建完成:', stats);

                    // 异步分片预热 Token 缓存（🚀 v2.2 提速：分片 50 → 100）
                    await tokenCache.warmupAsync(newLibrary, 100);
                    if (taskId !== buildTaskId) return;
                    console.log('⚡ Token 缓存预热完成:', tokenCache.getStats());
                } catch (e) {
                    console.error('⚠️ 搜索索引构建失败:', e);
                }
            }, 100);
        };
        // 🛡️ 打标期间跳过搜索索引全量重建的 watch 已移动到 useAITools 解构之后
        //    （原因：watch(isAITagging) 在 useAITools 解构前引用 isAITagging 会触发 TDZ：
        //     Cannot access 'Ms' before initialization —— vite build 不报错，运行时崩溃）
        // �📁 角色卡分组/分类：组合式函数注入（状态仍在 App.vue，此处仅注入操作逻辑）
        const {
            addNewCategory, currentCategoryDeletable, currentCategoryRenamable,
            deleteCustomCategory, renameCurrentCategory,
            currentCardCategory, handleCardCategoryChange, migrateOverlayKey, moveCardToGroup,
            quickMoveGroup, batchChangeCategory, batchChangeCategoryModal, cleanupEmptyCategories
        } = useCardGroups({ library, cardData, currentFolderPath, appConfig, selectedIds, customCategories, defaultCategories, removedDefaultKeys, currentCategoryKey, allCategories, isCategoryKnown, nativeAlert, confirmDialog, appPrompt, appSelect, getCategoryDisplayName, addLog, persistCardCategory, refreshLibrary, clearSelection, syncConfigToDisk });

        // ✅ 批量操作：组合式函数注入（共享状态 selectedIds/lastSelectedIndex 与工具 clearSelection/cleanupEmptyCategories/paginatedLibrary 等保留或来自其他组合式函数）
        const {
            handleCardClick, toggleSelection,
            batchBarStyle, startBatchBarDrag, resetBatchBarPos,
            batchExportSelected, batchDeleteSelected, batchAddTag
        } = useBatch({ selectedIds, lastSelectedIndex, library, cardData, openFromLibrary, paginatedLibrary, reset, cleanupEmptyCategories, persistCardUpdate, deleteCardOverlays, nativeAlert, confirmDialog, appPrompt, clearSelection });

        // � 换角色卡图：选择新立绘替换，成功后刷新路径/立绘，并展示校验校准结果
        // （item 为空时自动定位当前打开的卡片；PNG 卡原地替换，WebP / JSON 卡升级为标准 PNG 卡）
        const replaceCardImage = async (item) => {
            if (!item) {
                if (!cardData.value) return nativeAlert('请先打开一张卡片。', 'warning');
                item = library.value.find(i => i.data === cardData.value) || null;
                if (!item) return nativeAlert('未找到当前卡片的库记录。', 'warning');
            }
            if (!item || !item.path) return nativeAlert('未找到卡片文件路径', 'warning');
            if (!window.electronAPI || typeof window.electronAPI.replaceCardImage !== 'function') {
                return nativeAlert('当前版本不支持换卡图，请更新应用。', 'warning');
            }
            const ok = await confirmDialog(
                `将为角色卡【${item.name}】更换立绘图片。\n` +
                `（PNG 卡原地替换；WebP / JSON 卡将转为标准 PNG 卡）`
            );
            if (!ok) return;

            const payload = { cardPath: item.path };
            if (item.data) payload.cardJson = JSON.parse(JSON.stringify(item.data));

            const res = await window.electronAPI.replaceCardImage(payload);
            if (res && res.success) {
                const isImage = /\.(png|webp|jpe?g)$/i.test(res.newPath);
                const oldPath = item.path;
                item.path = res.newPath;
                item.fileName = res.newPath.split(/[\\/]/).pop();
                item.avatar = isImage ? `local-file://img/?path=${encodeURIComponent(res.newPath)}&_=${Date.now()}` : null;
                migrateOverlayKey(oldPath, res.newPath); // 分组/标签覆盖层跟随新路径
                // 若正打开该卡，刷新立绘显示
                if (cardData.value && item.data === cardData.value) {
                    imgUrl.value = item.avatar;
                }
                // 🛡️ shallowRef 修复：修改 library 内部对象不触发响应式，手动刷新（列表头像/文件名）
                triggerRef(library);
                nativeAlert(res.message || '换卡图成功', 'info');
            } else {
                nativeAlert(`换卡图失败: ${(res && res.error) || '未知错误'}`, 'error');
            }
        };

        // �🔍 查重与差异比对：组合式函数注入（estimateCardTokens 为共享工具，保留在 App.vue）
        const {
            showDedupeModal, duplicateGroups, startDedupeScan, resolveDedupeGroup,
            showWbDedupeModal, wbDuplicateGroups, startWorldbookDedupeScan, resolveWbDedupeGroup,
            showPresetDedupeModal, presetDuplicateGroups, startPresetDedupeScan, resolvePresetDedupeGroup,
            showContentDedupeModal, contentDuplicateGroups, startContentDedupeScan, resolveContentDedupeGroup,
            startSmartDedupe,
            showDiffDetailModal, diffMasterItem, diffCompareItem, diffFieldResults, openDiffDetailModal
        } = useDedupe({ library, worldbooks, activeWorldbook, cardData, presets, activePreset, appMode, estimateCardTokens, nativeAlert, confirmDialog, addLog, reset, cleanupEmptyCategories, deleteCardOverlays });

        // 🌍 世界书库与分组：组合式函数注入（共享状态 worldbooks/wbCategoryMap 等保留在 App.vue）
        const {
            importUrl, isImportingWb, wbContextMenu,
            loadWorldbooks, scanWorldbookDir, importWorldbookFromUrl, renameWorldbook,
            handleWorldbookFolderSelect, deleteWorldbook, duplicateWorldbook,
            openWbContextMenu, closeWbContextMenu, openWbInFolder,
            wbCategories, changeWbCategory, filteredWorldbooks
        } = useWorldbooks({ worldbooks, activeWorldbook, lastWorldbookDirPath, wbSearchQuery, wbFilterType, currentWbCategory, wbCategoryMap, saveWbCategoriesMap, syncWorldbooksToDisk, appMode, appPrompt, nativeAlert, confirmDialog, addLog, contextMenu, closeContextMenu });

        // 📚 世界书词条深度编辑 (Entry IDE)：组合式函数注入（activeWorldbook 等共享状态保留在 App.vue）
        const {
            ensureUid,
            addWorldbookEntry, deleteWorldbookEntry, duplicateWorldbookEntry, moveEntry,
            entrySearchQuery, entryFilterState, entrySortBy, filteredWorldbookEntries,
            // ⚠️ 重命名：与 useTags 的标签批量模式 batchMode 区分（词条批量模式为布尔开关）
            batchMode: entryBatchMode, batchSelected, toggleBatchMode: toggleEntryBatchMode, toggleBatchSelect, selectAllEntries, clearBatchSelection,
            batchToggleEnabled, batchDeleteEntries,
            entryHealthReport, runEntryHealthCheck
        } = useWorldbookEntries({ activeWorldbook, addLog, confirmDialog, nativeAlert });

        // 🔎 全库词条搜索与反向引用：组合式函数注入
        const {
            globalEntryIndex, globalEntrySearchQuery, globalEntrySearchResults,
            showGlobalEntrySearchModal, openGlobalEntrySearch, closeGlobalEntrySearch, jumpToEntrySource
        } = useGlobalEntrySearch({ worldbooks, library, appMode, activeWorldbook, openFromLibrary });

        // 📤 世界书扩展：提取/JSONL导入/批量导出/快照/统计
        const {
            extractWorldbookFromCard, importWbFromJsonl, exportWorldbooksBatch,
            showWbSnapshotModal, wbSnapshotList, wbSnapshotTarget, openWbSnapshots, closeWbSnapshotModal, restoreWbSnapshot, deleteWbSnapshot,
            wbStats
        } = useWorldbookExtras({ worldbooks, activeWorldbook, lastWorldbookDirPath, nativeAlert, addLog, confirmDialog });

        // ⚙️ 预设管理：组合式函数注入
        const {
            presetSearchQuery, isImportingPreset, importPresetUrl,
            loadPresets, scanPresetDir, filteredPresets,
            saveActivePreset, renamePreset, deletePreset, duplicatePreset,
            openPresetContextMenu, openPresetInFolder,
            importPresetFromUrl, exportPresetsBatch,
            listPresetSnapshots, restorePresetSnapshot, deletePresetSnapshot
        } = usePresets({
            presets, activePreset, lastPresetDirPath,
            nativeAlert, confirmDialog, addLog, appPrompt,
            contextMenu, closeContextMenu, appMode
        });

        // ✨ AI 打标 / 翻译 / 格式升维：组合式函数注入（共享状态与 API 配置保留在 App.vue）
        const {
            showAITagModal, aiCandidateTags, aiCustomPrompt, aiTaggingProgress, isAITagging, openAITagModal, startAITagging,
            enableAIExtraction, customAIPrompt, newAICandidateTag,
            addAICandidateTag, addAICandidateTagManual, removeAICandidateTag,
            activeSystemPromptId, addSystemPromptPreset, deleteSystemPromptPreset,
            saveSystemPromptsToStorage, getCurrentSystemPromptContent, buildTaggingSystemPrompt,
            useJailbreak, jailbreakPrompt, jailbreakPresets,
            isTranslating, translateCardContent, isRefactoring, refactorCardFormat,
            // 🧠 本地向量引擎（三层漏斗第二层）
            useLocalVector, vectorThreshold, vectorTopK,
            vectorStatus, vectorDownloading, vectorDownloadProgress, vectorDownloadSource, vectorBatchProgress,
            initVectorEngine, deleteVectorCache
        } = useAITools({ selectedIds, library, cardData, apiEndpoint, apiKey, apiType, resolveApiModel, extractReplyContent, persistCardUpdate, refreshCardData, nativeAlert, confirmDialog, showToast, systemPromptPresets, autoTagRules: compiledAutoTagRules });

        // �️ 打标期间跳过搜索索引全量重建（必须在 useAITools 解构 isAITagging 之后注册）：
        //    打标每改一张卡都会 triggerRef(library)，若此时重建索引 + Token 预热
        //    （几千张卡全量正则/分词），渲染进程 CPU/内存持续峰值 → native 崩溃
        //    （render-process-gone exitCode -36861）。改为标记 pending，打标结束后补建一次。
        //    ⚠️ 若移到 useAITools 解构之前，watch(isAITagging) 会触发 TDZ：
        //    Cannot access 'Ms' before initialization（vite build 不报错，运行时崩溃）
        watch(library, (newLibrary) => {
            if (isAITagging.value) {
                pendingRebuild = true;
                buildTaskId++; // 取消在途重建任务
                return;
            }
            pendingRebuild = false;
            rebuildSearchIndex(newLibrary);
        }, { deep: false }); // 只监听数组引用变化，不深监听卡片属性
        // 🛡️ 打标结束（isAITagging false）补建一次索引；延迟 250ms 防与末尾 triggerRef 重复
        watch(isAITagging, (tagging) => {
            if (!tagging && pendingRebuild) {
                setTimeout(() => {
                    if (pendingRebuild) {
                        pendingRebuild = false;
                        rebuildSearchIndex(library.value);
                    }
                }, 250);
            }
        });

        // �💬 聊天测卡：组合式函数注入（共享状态 apiEndpoint/apiKey/apiModel/apiType 与工具 resolveApiModel/extractReplyContent 保留在 App.vue）
        const {
            chatHistory, chatInput, isChatting, chatContainer,
            saveApiConfig, handleApiTypeChange,
            availableModels, isFetchingModels, fetchModelStatus, fetchAvailableModels,
            isChatRenderMode,
            initChat, sendMessage, clearChat
        } = useChat({ apiEndpoint, apiKey, apiModel, apiType, resolveApiModel, extractReplyContent, DEFAULT_API_ENDPOINT, syncConfigToDisk, nativeAlert, safeData, cardData });

        // 🕸️ 关系图谱：组合式函数注入（共享状态 library/cardData/imgUrl/currentTab/chatHistory/worldbookExpanded/allCategories/currentCategoryKey 保留或来自其他组合式函数）
        const {
            showGraph,
            graphLayoutMode, graphSearchKeyword, minLinkWeight,
            isolateCurrentGroup, edgeFilters, graphStats, graphBuilding,
            openGraph, closeGraph, renderGraph, updateGraphLayout, exportGraph
        } = useGraph({ library, cardData, imgUrl, currentTab, chatHistory, worldbookExpanded, nativeAlert, allCategories, currentCategoryKey });

        // 🌌 统一图谱入口：按当前模式智能分流——
        // 角色卡模式 → 角色宇宙关系图谱；世界书模式 → 当前世界书词条关联图谱
        // （顶栏唯一全局入口；世界书 IDE 编辑区另有「🌐 关系图谱」上下文快捷键）
        const openGraphSmart = () => {
            if (appMode.value === 'worldbooks') return openWbGraphModal();
            return openGraph();
        };

        // 🏷️ 标签系统：组合式函数注入（共享状态 systemCommonTags/tagLangMode 保留在 App.vue，此处注入操作逻辑与局部状态）
        const {
            showBatchTagModal, batchInputTags, batchMode, presetTagsLibrary,
            batchTagChips, toggleBatchCommonTag, removeBatchTag,
            toggleTagLangMode, getPresetTagText, displayTagText,
            togglePresetTag, executeBatchTagSave,
            globalAvailableTags, newGlobalTagInput, addTagToGlobalPool,
            removeTagFromGlobalPool, clearAllTagsFromPool, batchRemoveTags,
            appendTagToSearch, isEditingSystemTags, addGlobalTag
        } = useTags({ systemCommonTags, tagLangMode, library, sanitizeImportedTags, confirmDialog, nativeAlert, persistCardUpdate, cardData, searchQueryInput, selectedIds, clearSelection, syncConfigToDisk, createProgressToast });

        // ===== SFC 化：构建全局上下文对象（provide 给 HeaderBar/SidebarPanel/EditorPanel 子组件共享） =====
        const ctx = {
            theme, toggleTheme, appSettings, showApiModal, resetPersonalizationSettings, resetApiSettings,
            showExperimentalMenu, pushToTavern, showPushModal, currentOpenCardItem, currentPushTargetName, currentPushTargetHint, customPushTargets, currentCustomPushTarget,
            useSillyTavernPushTarget, useCustomPushTarget, setCurrentCustomPushTarget, addCustomPushTarget, renameCurrentCustomPushTarget, removeCurrentCustomPushTarget,
            viewOptions, importFileInput, handleImportFiles, importCards, downloadCardFromUrl, selectAllCards, cleanGlobalTagsPrompt, sanitizeImportedTags,
            openBakFolder, openTrashFolder, openGlobalTrash, openChatTab,
            isScanningDisk, diskScanProgress, useSizeFilter, runDiskScan, showDiskScanModal,
            currentFolderPath, handleScanImported, refreshLibrary,
            isDragging, dragCounter, handleDragEnter, handleDragLeave, cardData, imgUrl, tabs, currentTab, currentTabInfo,
            safeData, specVersion, worldbookEntries, getEntryUid, getRegexUid, regexScripts, formattedJson, refreshCardData,
            addRegexScript, deleteRegexScript, syncRegexScriptField,
            // 📊 渲染预览器（美化/状态栏）
            statusbarInput, statusbarViewMode, resetStatusbarDemo,
            statusbarTemplateMeta, statusbarPromptMeta,
            statusbarTemplates, expandedTemplateUid, toggleTemplateCard, fragmentScriptCount,
            showStatusDataPanel, statusDataCandidates, importStatusData, importAllStatusData,
            renderableScripts, toggleStatusbarScript, isScriptEnabled,
            appliedResult, previewHtml, loaderUrls, injectStatusbarTemplate, injectStatusbarPrompt,
            worldbookExpanded, toggleWorldbookEntry, expandAllWorldbook, collapseAllWorldbook,
            getKeysString, updateEntryKeys,
            getRegexPlacement, handleDrop, handleFileUpload, downloadJson, reset,
            library, openFromLibrary,
            allCategories, customCategories, currentCategoryKey,
            getCategoryDisplayName, addNewCategory,
            renameCurrentCategory, deleteCustomCategory, currentCategoryDeletable, currentCategoryRenamable,
            currentCardCategory, handleCardCategoryChange, moveCardToGroup, triggerManualSnapshot,
            snapshotConfig, saveSnapshotSettings,
            // 📸 历史快照查看与一键恢复
            showSnapshotModal, snapshotList, snapshotCardName, snapshotCardPath,
            openSnapshotModal, restoreSnapshot, openSnapshotFolder, closeSnapshotModal, deleteSnapshot, cleanAllSnapshots, cleanOrphanSnapshots,
            currentPage, totalPages,
            searchQuery, searchQueryInput, filteredLibrary, paginatedLibrary,
            selectFixedDirectory, addManualTag, changePage,
            exportLibraryDB, importLibraryDB,
            renameCard, exportWorldbook,
            selectedIds, handleCardClick, toggleSelection, clearSelection,
            batchBarStyle, startBatchBarDrag, resetBatchBarPos,
            isMultiSelectMode, viewMode, toggleViewMode, isCompactMode, sortBy,
            contextMenu, openContextMenu, closeContextMenu,
            quickMoveGroup, exportCard, deleteCardItem, handleContextMenuAction,
            replaceCardImage,
            batchChangeCategory, batchAddTag,
            batchChangeCategoryModal, batchExportSelected, batchDeleteSelected, cleanupEmptyCategories,
            showBatchTagModal, batchInputTags, batchMode, presetTagsLibrary,
            systemCommonTags, batchTagChips, toggleBatchCommonTag, removeBatchTag,
            tagLangMode, toggleTagLangMode, getPresetTagText, displayTagText,
            togglePresetTag, executeBatchTagSave,
            showAITagModal, aiCandidateTags, aiCustomPrompt, aiTaggingProgress, isAITagging, openAITagModal, startAITagging,
            enableAIExtraction, customAIPrompt, newAICandidateTag,
            addAICandidateTag, addAICandidateTagManual, removeAICandidateTag,
            isTranslating, translateCardContent,
            isRefactoring, refactorCardFormat,
            // 🧠 本地向量引擎（三层漏斗第二层）
            useLocalVector, vectorThreshold, vectorTopK,
            vectorStatus, vectorDownloading, vectorDownloadProgress, vectorDownloadSource, vectorBatchProgress,
            initVectorEngine, deleteVectorCache,
            toasts, showToast, notifySortDataStatus,
            systemPromptPresets, activeSystemPromptId, addSystemPromptPreset, deleteSystemPromptPreset, saveSystemPromptsToStorage, getCurrentSystemPromptContent, buildTaggingSystemPrompt,
            // 🚨 破限 (Jailbreak) 状态（对抗模型拒答/道德审查；localStorage 持久化）
            useJailbreak, jailbreakPrompt, jailbreakPresets,
            // 🏷️ 自动打标规则表（v2.1 可配置）
            showAutoTagRulesModal, autoTagRules, saveAutoTagRules, resetAutoTagRules,
            // ✏️ 自定义关键词库（候选词池，可增删）
            customKeywords, addCustomKeyword, removeCustomKeyword,
            globalAvailableTags, newGlobalTagInput, addTagToGlobalPool, removeTagFromGlobalPool, clearAllTagsFromPool, batchRemoveTags, appendTagToSearch,
            isEditingSystemTags, addGlobalTag,
            chatHistory, chatInput, isChatting, apiEndpoint, apiKey, apiModel, apiType, saveApiConfig, handleApiTypeChange, chatContainer,
            rebindTavernPath,
            availableModels, isFetchingModels, fetchModelStatus, fetchAvailableModels,
            isChatRenderMode, // 【新增暴露】渲染/代码模式开关
            sendMessage, clearChat,
            showGraph, graphBuilding, openGraph, closeGraph,
            graphLayoutMode, graphSearchKeyword, minLinkWeight,
            isolateCurrentGroup, edgeFilters, graphStats,
            updateGraphLayout, renderGraph, exportGraph,
            estimateTokens, cardTokenStats, estimateCardTokens,
            showTextModal, textModalTitle, textModalContent, textModalFontSize, openTextModal, saveTextModal,
            showImageModal, previewImageUrl, openImageModal,
            showGlobalAssetModal, globalAssetTab, globalAllWorldbooks, globalAllRegexScripts,
            renderHTML, renderSafeHTML, cleanMarkdownFences, deleteCard, updateName, saveToLocalDisk, exportPackage,
            activeCardTags, addSingleTag, removeSingleTag,
            tagModalVisible, tagInput, tagModalTitle,
            confirmSingleTag, closeSingleTagModal,
            promptModalVisible, promptModalTitle, promptInput,
            confirmPrompt, cancelPrompt,
            selectModalVisible, selectModalTitle, selectModalOptions, selectModalDefault, selectModalAllowCreate,
            appSelect, confirmSelect, confirmSelectCreate, cancelSelect,
            // 🌍 世界书双引擎模式
            appMode, worldbooks, activeWorldbook, lastWorldbookDirPath, editorLogs, showEditorLogs, addLog,
            loadWorldbooks, scanWorldbookDir, saveActiveWorldbook, exportActiveWorldbook, exportFilteredWorldbook, saveCurrentAsset,
            // ⚙️ 预设管理
            presets, activePreset, lastPresetDirPath,
            presetSearchQuery, isImportingPreset, importPresetUrl,
            loadPresets, scanPresetDir, filteredPresets,
            saveActivePreset, renamePreset, deletePreset, duplicatePreset,
            openPresetContextMenu, openPresetInFolder, importPresetFromUrl, exportPresetsBatch,
            listPresetSnapshots, restorePresetSnapshot, deletePresetSnapshot,
            // 🌍 世界书网址导入与重命名
            importUrl, isImportingWb, importWorldbookFromUrl, renameWorldbook,
            // 🌍 世界书文件夹导入 + 删除/克隆 + 专属右键菜单
            handleWorldbookFolderSelect, deleteWorldbook, duplicateWorldbook,
            wbContextMenu, openWbContextMenu, closeWbContextMenu, openWbInFolder,
            // 📁 世界书分组
            currentWbCategory, wbCategories, changeWbCategory,
            // 💾 统一 IPC 落盘
            syncWorldbooksToDisk,
            // 🌍 世界书词条深度编辑 (Entry IDE)
            ensureUid,
            addWorldbookEntry, deleteWorldbookEntry, duplicateWorldbookEntry, moveEntry,
            entrySearchQuery, entryFilterState, entrySortBy, filteredWorldbookEntries,
            entryBatchMode, batchSelected, toggleEntryBatchMode, toggleBatchSelect, selectAllEntries, clearBatchSelection,
            batchToggleEnabled, batchDeleteEntries,
            entryHealthReport, runEntryHealthCheck,
            // 🔎 全库词条搜索与反向引用
            globalEntryIndex, globalEntrySearchQuery, globalEntrySearchResults,
            showGlobalEntrySearchModal, openGlobalEntrySearch, closeGlobalEntrySearch, jumpToEntrySource,
            // 📤 世界书扩展
            extractWorldbookFromCard, importWbFromJsonl, exportWorldbooksBatch,
            showWbSnapshotModal, wbSnapshotList, wbSnapshotTarget, openWbSnapshots, closeWbSnapshotModal, restoreWbSnapshot, deleteWbSnapshot,
            wbStats,
            // 🎛️ 角色卡内嵌世界书细化操作（词条增删/克隆/排序/搜索/标签化触发词）
            characterWorldbookSearchQuery, filteredCharacterWorldbookEntries,
            addCharacterWorldbookEntry, deleteCharacterWorldbookEntry,
            duplicateCharacterWorldbookEntry, moveCharacterWorldbookEntry,
            addEntryKey, removeEntryKey, handleEntryKeyInput, updateEntryComment,
            // 📥 从世界书库导入词条到角色卡（与「📤 提取为世界书」对称）
            showCardWbImportModal, cardWbImportSource, cardWbImportCandidates, cardWbSelectedEntries,
            openCardWbImportModal, pickCardWbImportSource, confirmCardWbImport,
            // 🎨 三主题切换（暗夜/青灰/白昼）
            setTheme,
            // 🚀 首屏加载状态
            isAppLoading,
            // � 侧边栏宽度拖拽自定义
            sidebarEl, sidebarWidth, sidebarStyle, startSidebarResize, resetSidebarWidth,
            // �🔍 智能查重与版本清洗
            showDedupeModal, duplicateGroups, startDedupeScan, resolveDedupeGroup,
            // 🌍 世界书库筛选与对比查重
            wbSearchQuery, wbFilterType, filteredWorldbooks,
            showWbDedupeModal, wbDuplicateGroups, startWorldbookDedupeScan, resolveWbDedupeGroup,
            // ⚙️ 预设查重 + 🧬 内容级版本查重 + 🎯 智能查重统一入口（按当前视图自动分发）
            showPresetDedupeModal, presetDuplicateGroups, startPresetDedupeScan, resolvePresetDedupeGroup,
            showContentDedupeModal, contentDuplicateGroups, startContentDedupeScan, resolveContentDedupeGroup,
            startSmartDedupe,
            // ⚖️ 双屏差异比对器 (Diff Inspector)
            showDiffDetailModal, diffMasterItem, diffCompareItem, diffFieldResults, openDiffDetailModal,
            // 🌐 世界书关系图谱 v2（过滤/搜索/布局/统计/导出）+ 🔗 多书合并 + 🔀 条目导入
            showWbGraphModal, openWbGraphModal, closeWbGraphModal,
            wbGraphLayout, wbGraphSearch, wbGraphFilters, wbGraphMinWeight, wbGraphStats, wbGraphBuilding,
            updateWbGraphLayout, renderWbGraph, exportWbGraph,
            openGraphSmart,
            showWbMergeModal, selectedWbMergePaths, openWbMergeModal, executeWorldbookMerge,
            showWbImportModal, importSourceBook, importCandidates, selectedImportEntries, importableSourceBooks,
            openWbImportModal, pickImportSource, confirmImportEntries,
            // 🚀 系统版本更新检测
            showUpdateModal, updateInfo, updateErrorMsg, showUpdateBadge, dismissUpdateBadge, checkForUpdatesManual, openExternalUrl,
            // 🛡️ 统一持久化中枢（app_config.json 最高权威）
            appConfig, syncConfigToDisk, persistCardUpdate
        };
        provide('appCtx', ctx);
        return ctx;
    }
};

</script>

<style>

        /* ==========================================================
           🎨 全局主题变量系统 (暗夜 dark / 青灰 slate / 白昼 light)
           ========================================================== */
        :root, [data-theme="dark"] {
            --bg-app: #09090b;
            --bg-surface: #18181b;
            --bg-element: #27272a;
            --bg-hover: #3f3f46;
            --text-main: #f4f4f5;
            --text-sub: #a1a1aa;
            --border-color: #27272a;
            --accent-color: #6366f1;
            --accent-wb: #d97706;
        }
        [data-theme="slate"] {
            --bg-app: #0f172a;
            --bg-surface: #1e293b;
            --bg-element: #334155;
            --bg-hover: #475569;
            --text-main: #f8fafc;
            --text-sub: #94a3b8;
            --border-color: #334155;
            --accent-color: #38bdf8;
            --accent-wb: #f59e0b;
        }
        [data-theme="light"] {
            --bg-app: #f4f4f5;
            --bg-surface: #ffffff;
            --bg-element: #e4e4e7;
            --bg-hover: #d4d4d8;
            --text-main: #18181b;
            --text-sub: #71717a;
            --border-color: #e4e4e7;
            --accent-color: #4f46e5;
            --accent-wb: #b45309;
        }
        /* 主题语义类：供组件直接引用变量（配合 css/style.css 的 [data-theme] 类覆盖全量生效） */
        .theme-surface { background-color: var(--bg-surface); border-color: var(--border-color); color: var(--text-main); }
        .theme-element { background-color: var(--bg-element); border-color: var(--border-color); color: var(--text-main); }

        /* ==========================================================
           高分屏字体渲染优化 (2K/4K 下中文更锐利、不发虚、无彩边)
           ========================================================== */
        html, body {
            /* 开启 WebKit 字体抗锯齿，2K/4K 屏幕下字体会更平滑、不发虚 */
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            /* 强制引擎优先保证文字的可读性与字形渲染质量 */
            text-rendering: optimizeLegibility;
        }

        /* ==========================================================
           DPI 缩放锐化：解决 125% / 150% 等非整数缩放下的发虚
           ========================================================== */
        /* 解决非整数 DPI 缩放 (如 125%, 150%) 下的缩图发虚问题 */
        img {
            /* 强制影像渲染引擎优化对比度，保持立绘与头像的锐利边缘 */
            image-rendering: -webkit-optimize-contrast;
        }

        /* 解决高 DPI 下 1px 边框被次像素抹除/发糊的问题 */
        /* 将所有外框线转换为高精度渲染模式 */
        .border, .border-b, .border-r, .border-t {
            /* 配合硬件加速，锁定像素网格对齐 */
            transform: translateZ(0);
            backface-visibility: hidden;
        }

        /* 如果外围容器有毛玻璃效果 (backdrop-blur)，确保它在缩放时不出撕裂黑边 */
        .backdrop-blur-sm, .backdrop-blur-md {
            -webkit-backdrop-filter: blur(8px) translateZ(0);
            backdrop-filter: blur(8px) translateZ(0);
        }

        /* ==========================================================
           双轨字号接管：
           1) --ui-fs 接管外围界面（顶部导航、侧边栏、菜单、按钮、弹窗）
           2) --workspace-fs 仅接管右侧编辑区（textarea / pre / 聊天气泡）
           ========================================================== */
        body, #app, nav, aside, header, footer,
        .ui-text, button, select, input:not(textarea) {
            font-size: var(--ui-fs, 13px) !important;
        }
        main textarea,          /* 接管所有多行文本输入框 (世界书、设定描述等) */
        main pre,               /* 接管 Raw JSON 原始代码展示区 */
        main .leading-relaxed,  /* 接管聊天测卡界面的对话气泡内容 */
        .workspace-editor {     /* 通用工作区编辑器标记 */
            font-size: var(--workspace-fs, 14px) !important;
        }
    
</style>
