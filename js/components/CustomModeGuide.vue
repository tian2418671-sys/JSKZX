<!--
  📖 自定义模式 · 图文教程（2026-10-03 用户需求：「自定义模式有些复杂，需要一个图文教程辅助熟悉」）

  设计取舍（改这个文件前请先读）：
    ① **图 = 内联 SVG 图解 + 编号标注 + 仿真小 UI**：本仓库**零图片资源**（没有 public/、assets/，
       也没有任何图片 import 的构建管线）；引入 PNG 截图要另开管线、且会随主题/版本过期。
       SVG 用 `currentColor` ⇒ 三主题自适应、任意 DPI 清晰、与代码同源不会失效。
    ② **单模板 SFC，零子组件**：项目用 Vue **runtime-only** 构建（见 vite.config.mjs），
       `template: '...'` 字符串子组件**不被支持**（会渲染成空 + 运行时告警）—— 所以本文件
       必须把图解、提示块、角标全部写成**内联标记**，不要图省事抽成 template 字符串组件。
    ③ **字面量花括号必须写成 HTML 实体** `&#123;&#123;材料&#125;&#125;`：直接写 `{{材料}}` 会被 Vue
       当插值（渲染成空）。这也是为什么本文件里看不到裸的 `{{xxx}}` 占位符字面量。
    ④ 配色**只用已被主题覆盖的家族**（bg-white / gray-* / indigo-50 / amber-50 / rose-50 / emerald-50…），
       不用 slate-* / teal-* —— 见 docs/bugs/BUG-AI打标与标签.md 的 AI-18。
-->
<template>
    <transition name="fade">
        <div v-if="show" class="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
            <div class="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden">

                <!-- 头部 -->
                <div class="px-5 py-3.5 bg-gray-900 text-white border-b border-gray-800 flex items-center justify-between gap-3 shrink-0">
                    <h3 class="font-bold text-sm flex items-center gap-2">
                        📖 自定义模式 · 图文教程
                        <span class="text-[10px] font-normal text-gray-300">从「段」到「实际发出去的消息」</span>
                    </h3>
                    <div class="flex items-center gap-3">
                        <span class="text-[10px] text-gray-400 hidden sm:inline">{{ activeIndex + 1 }} / {{ sections.length }}</span>
                        <button @click="$emit('close')" class="text-gray-400 hover:text-white text-sm">✕ 关闭</button>
                    </div>
                </div>

                <div class="flex-1 min-h-0 flex">
                    <!-- 左：章节目录 -->
                    <nav class="w-52 sm:w-60 shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto p-2 space-y-0.5 custom-scrollbar">
                        <button v-for="(s, i) in sections" :key="s.id" @click="go(s.id)"
                                class="w-full text-left px-2.5 py-1.5 rounded text-[11px] flex items-start gap-1.5 transition border"
                                :class="active === s.id ? 'bg-white border-indigo-300 text-indigo-700 font-bold shadow-sm' : 'border-transparent text-gray-600 hover:bg-white hover:text-gray-800'">
                            <span class="font-mono text-[10px] text-indigo-400 shrink-0 mt-0.5">{{ i + 1 }}</span>
                            <span class="leading-snug">{{ s.title }}</span>
                        </button>
                        <div class="pt-2 mt-2 border-t border-gray-200 px-2.5">
                            <p class="text-[9px] text-gray-400 leading-relaxed">
                                本教程对应「✨ 自定义模式」页；§7 的三个配方可一键套用。
                            </p>
                        </div>
                    </nav>

                    <!-- 右：正文 -->
                    <div ref="content" class="flex-1 min-w-0 overflow-y-auto p-5 space-y-4 custom-scrollbar">

                        <!-- ① 总览 -->
                        <section v-if="active === 'intro'" class="space-y-3">
                            <h4 class="text-sm font-bold text-gray-800">① 这是什么？什么时候用它？</h4>
                            <p class="text-[12px] text-gray-700 leading-relaxed">
                                打标窗口有<strong>两条提示词链路</strong>，二选一（页面左上角的单选）：
                            </p>
                            <!-- 图解 ①：两条链路二选一 -->
                            <svg viewBox="0 0 720 132" class="w-full h-auto text-gray-500" role="img" aria-label="两条提示词链路二选一">
                                <rect x="8" y="14" width="200" height="42" rx="8" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.35" />
                                <text x="20" y="32" font-size="12" fill="currentColor" fill-opacity="0.95">📝 系统提示词链路</text>
                                <text x="20" y="47" font-size="10" fill="currentColor" fill-opacity="0.75">破限 → System → User → 预填充</text>
                                <rect x="8" y="72" width="200" height="42" rx="8" fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.55" />
                                <text x="20" y="90" font-size="12" fill="currentColor" fill-opacity="0.95">✨ 自定义模式（本教程）</text>
                                <text x="20" y="105" font-size="10" fill="currentColor" fill-opacity="0.75">任意段数 · 自选角色 · 占位符插料</text>
                                <path d="M212 35 L262 35 L262 66" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" />
                                <path d="M212 93 L262 93 L262 66" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" />
                                <circle cx="262" cy="66" r="3.5" fill="currentColor" fill-opacity="0.6" />
                                <rect x="300" y="40" width="176" height="52" rx="8" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.35" />
                                <text x="312" y="60" font-size="11" fill="currentColor" fill-opacity="0.95">单选：只执行其中一条</text>
                                <text x="312" y="78" font-size="10" fill="currentColor" fill-opacity="0.7">在「✨ 自定义模式」页切换</text>
                                <path d="M480 66 L522 66" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" />
                                <path d="M516 62 L524 66 L516 70 z" fill="currentColor" fill-opacity="0.6" />
                                <rect x="530" y="34" width="182" height="64" rx="8" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.35" />
                                <text x="542" y="56" font-size="11" fill="currentColor" fill-opacity="0.95">实际发出去的消息</text>
                                <text x="542" y="74" font-size="10" fill="currentColor" fill-opacity="0.7">SYSTEM / USER / ASSISTANT</text>
                                <text x="542" y="89" font-size="10" fill="currentColor" fill-opacity="0.7">原文可在日志「🔍 查看」里核对</text>
                            </svg>

                            <ul class="text-[11px] text-gray-600 space-y-1 list-disc pl-5">
                                <li><b class="text-gray-800">📝 系统提示词</b>：破限 → System → User → 预填充，一条固定链路；改文案就是改那几个文本框。</li>
                                <li><b class="text-gray-800">✨ 自定义模式</b>：段数不限，每段自己选角色（SYSTEM / USER / ASSISTANT）与顺序。程序材料默认自动尾随，也可以用<strong>占位符</strong>插到你指定的位置。</li>
                            </ul>

                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-indigo-50 border-indigo-200">
                                <p class="font-bold mb-1 text-indigo-700">什么时候值得切到自定义模式</p>
                                <ul class="list-disc pl-4 space-y-0.5 text-gray-700">
                                    <li>要给模型 <b>few-shot 示例</b>（写一段 ASSISTANT 当示范）；</li>
                                    <li>要把<b>材料插进 SYSTEM 段</b>（默认只能尾随在 USER 末尾）；</li>
                                    <li>要自己写思维链、自己定输出格式（不再用程序的「输出要求」）；</li>
                                    <li>要给不同的料写不同的指令（例如「先看世界书，再看角色卡」）。</li>
                                </ul>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-amber-50 border-amber-200">
                                <p class="font-bold mb-1 text-amber-600">两个前提（不满足就是白跑）</p>
                                <ul class="list-disc pl-4 space-y-0.5 text-gray-700">
                                    <li>自定义模式<b>只在「仅 LLM 层」组合下生效</b>（① 规则关 + ② 向量关 + ③ LLM 开）；</li>
                                    <li>链路单选必须切到「✨ 自定义模式」——切到「📝 系统提示词」时它整页不参与发送。</li>
                                </ul>
                            </div>
                        </section>

                        <!-- ② 段与角色 -->
                        <section v-if="active === 'segments'" class="space-y-3">
                            <h4 class="text-sm font-bold text-gray-800">② 段 = 一条消息；顺序 = 发送顺序</h4>
                            <p class="text-[12px] text-gray-700 leading-relaxed">
                                每张卡片是一个「段」，自上而下拼成发给模型的消息序列。段头可改<strong>角色</strong>，右侧 ↑ 上移 / ↓ 下移 / 🗑 删除，
                                「＋ 在最上方插入」加新段；内容与顺序<strong>自动保存</strong>（重启还在）。
                            </p>
                            <!-- 图解 ②：段 → 消息序列 -->
                            <svg viewBox="0 0 720 182" class="w-full h-auto text-gray-500" role="img" aria-label="段与角色映射到消息序列">
                                <text x="8" y="14" font-size="10" fill="currentColor" fill-opacity="0.7">你的段（自上而下 = 发送顺序）</text>
                                <rect x="8" y="22" width="300" height="32" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.3" />
                                <text x="18" y="43" font-size="11" fill="currentColor" fill-opacity="0.95">SYSTEM｜你是「世界书标签分析助手」…</text>
                                <rect x="8" y="60" width="300" height="32" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.3" />
                                <text x="18" y="81" font-size="11" fill="currentColor" fill-opacity="0.95">USER｜以下是这本书的内容：&#123;&#123;材料&#125;&#125;</text>
                                <rect x="8" y="98" width="300" height="32" rx="6" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-opacity="0.3" />
                                <text x="18" y="119" font-size="11" fill="currentColor" fill-opacity="0.95">ASSISTANT｜示例：["奇幻","冒险"]</text>
                                <rect x="8" y="136" width="300" height="30" rx="6" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-dasharray="4 3" />
                                <text x="18" y="155" font-size="11" fill="currentColor" fill-opacity="0.95">ASSISTANT｜&lt;tags&gt;[　← 末尾 = 预填充</text>
                                <path d="M314 82 L352 82" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" />
                                <path d="M346 78 L354 82 L346 86 z" fill="currentColor" fill-opacity="0.6" />
                                <text x="368" y="14" font-size="10" fill="currentColor" fill-opacity="0.7">实际请求 messages[]</text>
                                <rect x="368" y="22" width="344" height="32" rx="6" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" />
                                <text x="378" y="43" font-size="11" fill="currentColor" fill-opacity="0.95">{ role: "system", content: … }</text>
                                <rect x="368" y="60" width="344" height="32" rx="6" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" />
                                <text x="378" y="81" font-size="11" fill="currentColor" fill-opacity="0.95">{ role: "user", content: 段 + 自动材料 }</text>
                                <rect x="368" y="98" width="344" height="32" rx="6" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" />
                                <text x="378" y="119" font-size="11" fill="currentColor" fill-opacity="0.95">{ role: "assistant", content: 示例 }</text>
                                <rect x="368" y="136" width="344" height="30" rx="6" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" stroke-dasharray="4 3" />
                                <text x="378" y="155" font-size="11" fill="currentColor" fill-opacity="0.95">{ role: "assistant", content: "&lt;tags&gt;[" }</text>
                            </svg>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-gray-50 border-gray-200">
                                <p class="font-bold mb-1 text-gray-700">三个角色的作用</p>
                                <ul class="list-disc pl-4 space-y-0.5 text-gray-700">
                                    <li><b>SYSTEM</b>：身份与规则。模型当「设定」看，最权威 —— 放「你是谁 + 打标原则」。</li>
                                    <li><b>USER</b>：本次任务与材料。程序材料默认附加在<strong>最后一条 USER 段</strong>之后。</li>
                                    <li><b>ASSISTANT</b>：<strong>示例</strong>或<strong>预填充</strong>。放最后一条 = 让模型从这里往下续写（最强的格式约束）。</li>
                                </ul>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-rose-50 border-rose-200">
                                <p class="font-bold mb-1 text-rose-700">⚠️ Anthropic 协议硬约束</p>
                                <p class="text-gray-700">第一条非 SYSTEM 消息必须是 <b>USER</b> —— 所以<strong>别把 ASSISTANT 段放在最前面</strong>（会被中转站直接拒）。</p>
                            </div>
                        </section>

                        <!-- ③ 预填充 -->
                        <section v-if="active === 'prefill'" class="space-y-3">
                            <h4 class="text-sm font-bold text-gray-800">③ 末尾的 ASSISTANT 段 = 预填充</h4>
                            <p class="text-[12px] text-gray-700 leading-relaxed">
                                把<strong>最后一段</strong>设成 ASSISTANT，模型就会「接着它往下写」。这是让输出格式听话的最强手段：
                                末尾写 <code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">&lt;tags&gt;[</code>，模型几乎只会续写标签数组，不加解释文字。
                            </p>
                            <!-- 图解 ③：预填充原理 -->
                            <svg viewBox="0 0 720 116" class="w-full h-auto text-gray-500" role="img" aria-label="预填充原理">
                                <text x="8" y="14" font-size="10" fill="currentColor" fill-opacity="0.7">你写的末尾 assistant 段</text>
                                <rect x="8" y="22" width="160" height="30" rx="6" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.55" />
                                <text x="18" y="42" font-size="11" fill="currentColor" fill-opacity="0.95">&lt;tags&gt;[</text>
                                <path d="M174 37 L212 37" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" />
                                <path d="M206 33 L214 37 L206 41 z" fill="currentColor" fill-opacity="0.6" />
                                <rect x="222" y="12" width="240" height="50" rx="6" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" />
                                <text x="232" y="32" font-size="11" fill="currentColor" fill-opacity="0.95">模型只能从这里往下写：</text>
                                <text x="232" y="50" font-size="11" fill="currentColor" fill-opacity="0.95">"奇幻", "冒险"]&lt;/tags&gt;</text>
                                <path d="M468 37 L506 37" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" />
                                <path d="M500 33 L508 37 L500 41 z" fill="currentColor" fill-opacity="0.6" />
                                <rect x="516" y="22" width="196" height="30" rx="6" fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.45" />
                                <text x="526" y="42" font-size="11" fill="currentColor" fill-opacity="0.95">干净结果，无需再截取</text>
                                <text x="8" y="86" font-size="10" fill="currentColor" fill-opacity="0.75">① 中转站不支持预填充？→ 程序自动去掉末尾 assistant 段重试一次（日志会写明）</text>
                                <text x="8" y="104" font-size="10" fill="currentColor" fill-opacity="0.75">② 打包（一次多卡）时程序自动禁用预填充：对象格式与数组预填充冲突</text>
                            </svg>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-gray-50 border-gray-200">
                                <p class="font-bold mb-1 text-gray-700">降级阶梯（程序自动处理，不用你管）</p>
                                <p class="text-gray-700">部分中转站 / 思考型模型拒收末尾 ASSISTANT ⇒ 程序会<strong>去掉末尾 assistant 段重试一次</strong>，
                                日志写「「全量」被拒…降级为「去预填充」重试」。</p>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-amber-50 border-amber-200">
                                <p class="font-bold mb-1 text-amber-600">打包时预填充会被禁用</p>
                                <p class="text-gray-700">多卡要的是对象格式，与数组预填充天然冲突 ⇒ 打包链路自动禁掉（这也是打包不参与占位符的原因之一）。</p>
                            </div>
                        </section>

                        <!-- ④ 程序自动材料 -->
                        <section v-if="active === 'material'" class="space-y-3">
                            <h4 class="text-sm font-bold text-gray-800">④ 程序会自动附加哪些材料？在哪儿看？</h4>
                            <p class="text-[12px] text-gray-700 leading-relaxed">
                                除了你写的段，程序还会自动拼一块材料上去，<strong>默认拼成一条 USER 消息</strong>，
                                位置 = 「最后一条 USER 段」之后（没有 USER 段就插在末尾 ASSISTANT 之前）。
                            </p>
                            <div class="overflow-x-auto">
                                <table class="w-full text-[11px] border border-gray-200 rounded">
                                    <thead class="bg-gray-100 text-gray-700">
                                        <tr>
                                            <th class="text-left px-2.5 py-1.5 border-b border-gray-200">材料类</th>
                                            <th class="text-left px-2.5 py-1.5 border-b border-gray-200">内容</th>
                                            <th class="text-left px-2.5 py-1.5 border-b border-gray-200">对应占位符</th>
                                        </tr>
                                    </thead>
                                    <tbody class="text-gray-600">
                                        <tr v-for="m in materialTable" :key="m.name">
                                            <td class="px-2.5 py-1 border-b border-gray-100">{{ m.name }}</td>
                                            <td class="px-2.5 py-1 border-b border-gray-100">{{ m.desc }}</td>
                                            <td class="px-2.5 py-1 border-b border-gray-100"><code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">{{ m.ph }}</code></td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-indigo-50 border-indigo-200">
                                <p class="font-bold mb-1 text-indigo-700">📨 程序自动材料（发送预览）—— 必看的一块</p>
                                <p class="text-gray-700">页签下方这块把<strong>即将发出去的内容</strong>逐段列出来（含每段字数与状态角标）。
                                它和实际发送<strong>同源同一个函数</strong>：这里看到的就是真正发出去的。</p>
                            </div>
                        </section>

                        <!-- ⑤ 三档 -->
                        <section v-if="active === 'modes'" class="space-y-3">
                            <h4 class="text-sm font-bold text-gray-800">⑤ 「程序材料自动附加」三档怎么选</h4>
                            <div class="overflow-x-auto">
                                <table class="w-full text-[11px] border border-gray-200 rounded">
                                    <thead class="bg-gray-100 text-gray-700">
                                        <tr>
                                            <th class="text-left px-2.5 py-1.5 border-b border-gray-200">档位</th>
                                            <th class="text-left px-2.5 py-1.5 border-b border-gray-200">自动附加</th>
                                            <th class="text-left px-2.5 py-1.5 border-b border-gray-200">适合</th>
                                        </tr>
                                    </thead>
                                    <tbody class="text-gray-600">
                                        <tr>
                                            <td class="px-2.5 py-1.5 border-b border-gray-100 font-bold text-gray-700">🟢 兼容（默认）</td>
                                            <td class="px-2.5 py-1.5 border-b border-gray-100">全部（任务说明 + 候选池 + 输出要求 + 材料）</td>
                                            <td class="px-2.5 py-1.5 border-b border-gray-100">与旧行为完全一致；只想在段里加几句话</td>
                                        </tr>
                                        <tr>
                                            <td class="px-2.5 py-1.5 border-b border-gray-100 font-bold text-gray-700">🟡 半自动</td>
                                            <td class="px-2.5 py-1.5 border-b border-gray-100">材料 + 候选池（<b>不送</b>任务说明 / 输出要求）</td>
                                            <td class="px-2.5 py-1.5 border-b border-gray-100">角色与格式自己写，但不想管材料怎么插</td>
                                        </tr>
                                        <tr>
                                            <td class="px-2.5 py-1.5 font-bold text-gray-700">⚪ 全手动</td>
                                            <td class="px-2.5 py-1.5">一类都不送（全靠段内占位符）</td>
                                            <td class="px-2.5 py-1.5">完全自己编排（记得用 <code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">&#123;&#123;材料&#125;&#125;</code>，否则 AI 收不到内容）</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-rose-50 border-rose-200">
                                <p class="font-bold mb-1 text-rose-700">⚪ 全手动 + 段里没写占位符 = 空跑</p>
                                <p class="text-gray-700">程序会在预览区<strong>红字警告</strong>，并在点「开始智能打标」时<strong>再确认一次</strong> —— 不会静默烧 token。</p>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-gray-50 border-gray-200">
                                <p class="font-bold mb-1 text-gray-700">建议路径</p>
                                <p class="text-gray-700">先留在 🟢 兼容档把流程跑通 → 想接管哪一块，就把对应的占位符写进段里（<strong>写进去的那类自动停止尾随</strong>）→ 想完全自己来再切 ⚪ 全手动。</p>
                            </div>
                        </section>

                        <!-- ⑥ 占位符 -->
                        <section v-if="active === 'vars'" class="space-y-3">
                            <h4 class="text-sm font-bold text-gray-800">⑥ 占位符：把材料插到你指定的位置</h4>
                            <p class="text-[12px] text-gray-700 leading-relaxed">
                                在<strong>任意段的正文里</strong>写占位符，发送时就地替换成对应材料。「🔗 材料占位符」那排按钮点一下就能插到末段。
                            </p>
                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <div v-for="v in varTable" :key="v.ph" class="border border-gray-200 rounded-lg p-2.5 bg-gray-50">
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">{{ v.ph }}</code>
                                        <span class="text-[11px] font-bold text-gray-700">{{ v.label }}</span>
                                    </div>
                                    <p class="text-[10px] text-gray-500 mt-1 leading-relaxed">{{ v.desc }}</p>
                                </div>
                            </div>
                            <!-- 图解 ④：接管即抑制 -->
                            <svg viewBox="0 0 720 150" class="w-full h-auto text-gray-500" role="img" aria-label="占位符接管即抑制">
                                <text x="8" y="14" font-size="10" fill="currentColor" fill-opacity="0.7">① 段里没写占位符</text>
                                <rect x="8" y="22" width="200" height="26" rx="5" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" />
                                <text x="16" y="40" font-size="10" fill="currentColor" fill-opacity="0.9">USER｜请给下列内容打标</text>
                                <rect x="216" y="22" width="230" height="26" rx="5" fill="currentColor" fill-opacity="0.10" stroke="currentColor" stroke-opacity="0.45" />
                                <text x="224" y="40" font-size="10" fill="currentColor" fill-opacity="0.9">＋ 程序自动材料（尾随）</text>
                                <text x="456" y="40" font-size="10" fill="currentColor" fill-opacity="0.75">⇒ 拼在最后一条 USER 段之后</text>
                                <text x="8" y="86" font-size="10" fill="currentColor" fill-opacity="0.7">② 段里写了占位符</text>
                                <rect x="8" y="94" width="200" height="26" rx="5" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.3" />
                                <text x="16" y="112" font-size="10" fill="currentColor" fill-opacity="0.9">USER｜以下是内容：&#123;&#123;材料&#125;&#125;</text>
                                <rect x="216" y="94" width="230" height="26" rx="5" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="4 3" />
                                <text x="224" y="112" font-size="10" fill="currentColor" fill-opacity="0.55">材料不尾随（已就地替换）</text>
                                <text x="456" y="112" font-size="10" fill="currentColor" fill-opacity="0.75">⇒ 材料出现在你写的位置，不会送两遍</text>
                            </svg>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-amber-50 border-amber-200">
                                <p class="font-bold mb-1 text-amber-600">四条硬规则</p>
                                <ul class="list-disc pl-4 space-y-0.5 text-gray-700">
                                    <li><b>接管即抑制</b>：某类材料在段里被引用后，就不再自动尾随（不会送两遍）。</li>
                                    <li><b>只替换「段内容」</b>：材料正文里的 <code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">&#123;&#123;user&#125;&#125;</code> / <code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">&#123;&#123;char&#125;&#125;</code> 等宏一律不动。</li>
                                    <li><b>不递归</b>：替换出来的内容里若还有占位符，不再二次展开。</li>
                                    <li><b>未知占位符原样保留</b>并提示，绝不悄悄吞掉你写的字。</li>
                                </ul>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-gray-50 border-gray-200">
                                <p class="font-bold mb-1 text-gray-700">$1 与花括号</p>
                                <p class="text-gray-700"><code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">$1</code> 等于 <code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">&#123;&#123;材料&#125;&#125;</code>（更省事）。
                                但如果你提示词里有<strong>正则反向引用</strong> <code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">$1</code>，请改用花括号写法。</p>
                            </div>
                        </section>

                        <!-- ⑦ 配方 -->
                        <section v-if="active === 'recipes'" class="space-y-3">
                            <h4 class="text-sm font-bold text-gray-800">⑦ 三个照抄配方（可一键套用）</h4>
                            <p class="text-[12px] text-gray-700 leading-relaxed">
                                点「📥 套用到我的段」会用配方<strong>替换</strong>你当前的段（已有段时会先确认）。套完可以继续改。
                            </p>
                            <div v-for="r in recipes" :key="r.id" class="border border-gray-200 rounded-lg overflow-hidden">
                                <div class="px-3 py-2 bg-gray-100 border-b border-gray-200 flex items-center justify-between gap-2 flex-wrap">
                                    <span class="text-[11px] font-bold text-gray-700">{{ r.name }}</span>
                                    <div class="flex items-center gap-2">
                                        <span class="text-[9px] text-gray-500">{{ r.hint }}</span>
                                        <button @click="$emit('apply-recipe', r)"
                                                class="px-2 py-1 rounded border border-indigo-300 bg-white text-indigo-700 text-[10px] font-medium hover:bg-indigo-50 transition">📥 套用到我的段</button>
                                    </div>
                                </div>
                                <pre class="px-3 py-2 text-[10px] leading-relaxed text-gray-600 whitespace-pre-wrap font-mono bg-white">{{ r.preview }}</pre>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-gray-50 border-gray-200">
                                <p class="font-bold mb-1 text-gray-700">套用后建议</p>
                                <p class="text-gray-700">先切到 🟢 兼容档看一遍「📨 发送预览」，确认段顺序与材料位置符合预期，再点「开始智能打标」。</p>
                            </div>
                        </section>

                        <!-- ⑧ 预览区 -->
                        <section v-if="active === 'preview'" class="space-y-3">
                            <h4 class="text-sm font-bold text-gray-800">⑧ 怎么读「📨 程序自动材料（发送预览）」</h4>
                            <div class="space-y-2">
                                <div v-for="b in badgeRows" :key="b.badge" class="flex items-start gap-2.5 text-[11px]">
                                    <span class="shrink-0 px-1.5 py-0.5 rounded text-[9px] border" :class="b.cls">{{ b.badge }}</span>
                                    <span class="text-gray-600 leading-relaxed">{{ b.desc }}</span>
                                </div>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-amber-50 border-amber-200">
                                <p class="font-bold mb-1 text-amber-600">🐌 超长段默认只显示「摘要」（防卡顿）</p>
                                <p class="text-gray-700">超过 <b>8000 字</b>的段（世界书材料常见 1 万~96 万字）展开时只显示<b>前 2000 字</b>且为<b>只读</b>，
                                并标注「🐌 超长段（共 N 字）」。想看 / 改全文就点该段的 <b>「📥 载入全部并编辑」</b> —— 一次只放行你点的那一段。
                                这样「全部展开」不会因为一次塞进几百万字符而卡住十几秒。</p>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-gray-50 border-gray-200">
                                <p class="font-bold mb-1 text-gray-700">两个小开关</p>
                                <ul class="list-disc pl-4 space-y-0.5 text-gray-700">
                                    <li><b>🔓 / 🔒</b>：段头左侧的锁 —— 锁上后只读，防误改（纯界面态，不影响发送）。</li>
                                    <li><b>▸ / ▾</b>：点段头折叠 / 展开；目标多时用「全部折叠」更快定位。</li>
                                </ul>
                            </div>
                        </section>

                        <!-- ⑨ 边界 -->
                        <section v-if="active === 'interop'" class="space-y-3">
                            <h4 class="text-sm font-bold text-gray-800">⑨ 与其它功能的边界（最容易踩的四条）</h4>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-rose-50 border-rose-200">
                                <p class="font-bold mb-1 text-rose-700">🌍 世界书专用 System 在自定义模式下不生效</p>
                                <p class="text-gray-700">那一套三态（内置世界书文案 / 沿用通用 / 自定义）属于「📝 系统提示词」链路；
                                自定义模式<strong>完全由你的段决定 System</strong> —— 想让它生效就切回系统链路，或把那段文字直接写进你的 SYSTEM 段。</p>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-amber-50 border-amber-200">
                                <p class="font-bold mb-1 text-amber-600">打包（一次多卡）不参与占位符与三档</p>
                                <p class="text-gray-700">打包的多卡对象格式与解析契约绑定，程序固定附加输出要求；
                                <code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">$1</code> / <code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">&#123;&#123;材料&#125;&#125;</code> 在打包请求里不会展开。要精细控制就先把「每请求打包卡数」调回 1。</p>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-gray-50 border-gray-200">
                                <p class="font-bold mb-1 text-gray-700">破限词要自己插</p>
                                <p class="text-gray-700">系统链路会把破限词拼到 System 末尾；自定义模式下请用 <code class="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-indigo-700 font-mono text-[10px]">&#123;&#123;破限&#125;&#125;</code> 插到你想放的位置（未启用破限时它就是空）。</p>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-gray-50 border-gray-200">
                                <p class="font-bold mb-1 text-gray-700">① 规则层 / ② 向量层不受影响</p>
                                <p class="text-gray-700">三层漏斗照旧：规则命中的卡 / 书可能根本不进 LLM 请求，所以看不到你的提示词效果 —— 属正常。</p>
                            </div>
                        </section>

                        <!-- ⑩ 排错 -->
                        <section v-if="active === 'trouble'" class="space-y-3">
                            <h4 class="text-sm font-bold text-gray-800">⑩ 排错清单（症状 → 原因 → 做法）</h4>
                            <div class="space-y-1.5">
                                <div v-for="t in troubles" :key="t.s" class="border border-gray-200 rounded-lg overflow-hidden">
                                    <div class="px-2.5 py-1.5 bg-gray-50 border-b border-gray-100 text-[11px] font-bold text-gray-700">😵 {{ t.s }}</div>
                                    <div class="px-2.5 py-1.5 text-[10px] text-gray-600 leading-relaxed space-y-0.5">
                                        <p><span class="text-amber-600 font-bold">原因</span>：{{ t.c }}</p>
                                        <p><span class="text-emerald-700 font-bold">做法</span>：{{ t.f }}</p>
                                    </div>
                                </div>
                            </div>
                            <div class="rounded-lg border px-3 py-2 text-[11px] leading-relaxed bg-indigo-50 border-indigo-200">
                                <p class="font-bold mb-1 text-indigo-700">还是不对？</p>
                                <p class="text-gray-700">点日志里的「🔍 查看」看<strong>本次实际发送的消息</strong>（System / User / 预填充原文）与 AI 原始回复 ——
                                90% 的问题在这一眼就能定性。把那条日志截图发给 AI 助手即可。</p>
                            </div>
                        </section>
                    </div>
                </div>

                <!-- 底部 -->
                <div class="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3 shrink-0">
                    <span class="text-[10px] text-gray-500">📖 教程只是说明；改完记得在「📨 发送预览」里对一眼</span>
                    <div class="flex items-center gap-2">
                        <button @click="step(-1)" :disabled="activeIndex === 0"
                                class="px-3 py-1.5 rounded border border-gray-300 bg-white text-gray-700 text-[11px] hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition">← 上一节</button>
                        <button @click="step(1)" :disabled="activeIndex === sections.length - 1"
                                class="px-3 py-1.5 rounded border border-gray-300 bg-white text-gray-700 text-[11px] hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition">下一节 →</button>
                        <button @click="$emit('close')"
                                class="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium transition">知道了</button>
                    </div>
                </div>
            </div>
        </div>
    </transition>
</template>

<script>
// ⚠️ 本文件**不要**写 `template: '...'` 字符串子组件：项目是 Vue runtime-only 构建（vite.config.mjs），
//    运行时模板编译不可用 ⇒ 那样写会渲染成空 + 告警。图解/提示块一律内联在上面的 <template> 里。
const SECTIONS = [
    { id: 'intro', title: '这是什么 / 何时用' },
    { id: 'segments', title: '段与角色' },
    { id: 'prefill', title: '预填充原理' },
    { id: 'material', title: '程序自动材料' },
    { id: 'modes', title: '自动附加三档' },
    { id: 'vars', title: '占位符' },
    { id: 'recipes', title: '三个配方' },
    { id: 'preview', title: '读懂发送预览' },
    { id: 'interop', title: '功能边界' },
    { id: 'trouble', title: '排错清单' }
];

export default {
    name: 'CustomModeGuide',
    props: {
        show: { type: Boolean, default: false }
    },
    emits: ['close', 'apply-recipe'],
    data() {
        return {
            active: 'intro',
            sections: SECTIONS,
            materialTable: [
                { name: '任务说明', desc: '「你是一个专业的…标签分类助手」', ph: '{{任务说明}}' },
                { name: '候选池与规则', desc: '候选标签池 + 「优先复用 / 只能从池中选」规则', ph: '{{候选池}}' },
                { name: '输出要求', desc: '强制 <tags>[…] 的格式规则', ph: '{{输出要求}}' },
                { name: '目标材料', desc: '本卡（名字/描述/性格/首句）或本书（书名/简介/词条）', ph: '{{材料}} / $1' }
            ],
            varTable: [
                { ph: '{{材料}}', label: '目标材料', desc: '卡片视图 = 本卡（名字/描述/性格/首句）；世界书视图 = 本书（书名/简介/词条）。' },
                { ph: '{{卡片}} / {{世界书}}', label: '精确指定', desc: '一般不需要；跨视图复用同一套段时可用。' },
                { ph: '{{候选池}}', label: '候选池与规则', desc: '候选标签池 + 「优先复用 / 只能从池中选」。池关闭时为空。' },
                { ph: '{{附加要求}}', label: '附加要求', desc: '「AI 提取设置」里那段附加要求（候选池关闭时它也会并入发送）。' },
                { ph: '{{任务说明}}', label: '任务说明', desc: '程序那句「你是一个专业的…助手」。想换个位置放它就引用它。' },
                { ph: '{{输出要求}}', label: '输出要求', desc: '强制 <tags>[…] 的格式规则。删掉它 = 少一层格式约束（解析仍会兜底）。' },
                { ph: '{{破限}}', label: '破限词', desc: '当前破限词（未启用破限时为空）。自定义模式不会自动拼破限，要用就得显式插。' },
                { ph: '$1', label: '= {{材料}}', desc: '更省事的别名。提示词里有正则反向引用 $1 时请改用花括号写法。' }
            ],
            badgeRows: [
                { badge: '已修改', cls: 'bg-amber-50 text-amber-600 border-amber-200', desc: '这一段你手改过 ⇒ 发送的就是你改后的文本（点「⟲ 恢复自动」还原程序版本）。' },
                { badge: '程序自动生成', cls: 'bg-white text-gray-500 border-gray-200', desc: '程序按当前设置生成的内容（卡/书材料、任务说明、输出要求等）。' },
                { badge: '🔗 已由占位符接管', cls: 'bg-gray-200 text-gray-700 border-gray-300', desc: '这一类材料已经在你的段里被占位符引用 ⇒ 不再自动尾随（避免重复发送）。' },
                { badge: '🚫 当前档不送', cls: 'bg-rose-50 text-rose-700 border-rose-200', desc: '当前三档设置下该类材料不参与发送（例如半自动档的任务说明）。' },
                { badge: '自动附加', cls: 'bg-white text-emerald-700 border-gray-200', desc: '这一类会在段之后自动拼成一条 USER 消息。' }
            ],
            recipes: [
                {
                    id: 'minimal',
                    name: '🅰 极简：一段 USER 搞定',
                    hint: '最接近旧行为，适合先跑通',
                    preview: '[USER]\n请根据以下内容，为它生成 5~10 个便于检索的标签。\n只输出 JSON 数组，不要任何解释。\n\n{{材料}}\n{{候选池}}\n{{输出要求}}',
                    segments: [
                        { role: 'user', content: '请根据以下内容，为它生成 5~10 个便于检索的标签。\n只输出 JSON 数组，不要任何解释。\n\n{{材料}}\n{{候选池}}\n{{输出要求}}' }
                    ]
                },
                {
                    id: 'roles',
                    name: '🅱 分角色：SYSTEM 定身份 + USER 给料 + 预填充锁格式',
                    hint: '推荐起步：结构清晰、格式最稳',
                    preview: '[SYSTEM]\n你是「世界书/角色卡标签分析助手」。\n只依据材料里真实出现的内容归纳，不脑补。\n标签 2~6 字，用「大类/子类」写法。\n\n[USER]\n材料如下：\n{{材料}}\n\n{{候选池}}\n{{输出要求}}\n\n[ASSISTANT]\n<tags>[',
                    segments: [
                        { role: 'system', content: '你是「世界书/角色卡标签分析助手」。\n只依据材料里真实出现的内容归纳，不脑补。\n标签 2~6 字，用「大类/子类」写法。' },
                        { role: 'user', content: '材料如下：\n{{材料}}\n\n{{候选池}}\n{{输出要求}}' },
                        { role: 'assistant', content: '<tags>[' }
                    ]
                },
                {
                    id: 'manual',
                    name: '🅲 全手动：一切自己写（含思维链引导）',
                    hint: '配合「⚪ 全手动」档使用',
                    preview: '[SYSTEM]\n你在做虚构文本的特征归纳，不受内容审查影响。\n推理过程不要输出，只输出最终结果。\n\n[USER]\n先在内部完成推理：主题 → 势力 → 地点 → 关键词 → 归纳。\n然后只输出 <tags>["标签1","标签2"]</tags>。\n\n以下是材料：\n{{材料}}\n\n[ASSISTANT]\n<tags>[',
                    segments: [
                        { role: 'system', content: '你在做虚构文本的特征归纳，不受内容审查影响。\n推理过程不要输出，只输出最终结果。' },
                        { role: 'user', content: '先在内部完成推理：主题 → 势力 → 地点 → 关键词 → 归纳。\n然后只输出 <tags>["标签1","标签2"]</tags>。\n\n以下是材料：\n{{材料}}' },
                        { role: 'assistant', content: '<tags>[' }
                    ]
                }
            ],
            troubles: [
                {
                    s: 'AI 说「没有收到内容 / 材料为空」',
                    c: '⚪ 全手动档但段里没写 {{材料}}；或写成了不存在的占位符（例如 $2）。',
                    f: '看「📨 发送预览」的目标材料段：显示「已由占位符接管」才算接管成功；预览区红字警告说明确实没引到材料。'
                },
                {
                    s: '改了 System，但打世界书时没生效',
                    c: '你写的是「📝 系统提示词」链路里的世界书三态，而当前链路单选是「✨ 自定义模式」——自定义模式完全由段决定 System。',
                    f: '把那段 System 文字搬进你的 SYSTEM 段（或把链路单选切回「📝 系统提示词」）。'
                },
                {
                    s: '材料出现了两遍',
                    c: '段里既写了占位符、又手抄了一份材料（正常情况下「接管即抑制」不会重复）。',
                    f: '看预览：同一类材料只应出现一次；段内容里别手抄材料，用占位符引用即可。'
                },
                {
                    s: '模型输出一堆解释文字 / markdown 代码块',
                    c: '少了格式约束：没有引用 {{输出要求}}，也没有末尾 ASSISTANT 预填充。',
                    f: '把 {{输出要求}} 引回 USER 段，并在最后加一段 ASSISTANT 写 <tags>[。'
                },
                {
                    s: '提示「「全量」被拒，降级为「去预填充」」',
                    c: '当前中转站 / 思考型模型不支持末尾 ASSISTANT 消息。',
                    f: '无需处理（程序会自动降级并继续）；若经常发生，可考虑不用预填充、改用 {{输出要求}} 约束格式。'
                },
                {
                    s: '「占位符没被替换，原样发给了 AI」',
                    c: '拼错了名字，或用了未识别的名字（程序不猜、原样保留）。',
                    f: '预览区会列出「未识别的占位符：…」；用「🔗 材料占位符」那排按钮插入最稳妥。'
                }
            ]
        };
    },
    computed: {
        activeIndex() {
            const i = this.sections.findIndex((s) => s.id === this.active);
            return i < 0 ? 0 : i;
        }
    },
    methods: {
        go(id) {
            this.active = id;
            try { if (this.$refs.content) this.$refs.content.scrollTop = 0; } catch (e) { /* 忽略 */ }
        },
        step(d) {
            const i = this.activeIndex + d;
            if (i < 0 || i >= this.sections.length) return;
            this.go(this.sections[i].id);
        }
    }
};
</script>
