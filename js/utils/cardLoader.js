/**
 * 卡片加载与数据规范化工具
 * 支持 V1/V2/V3 规范以及 PNG / WebP / JPEG / JSON 格式。
 */
import { parsePNGChunk, deepScanForJSON } from './pngParser.js';

/**
 * 将卡片数据规范化为 V2 结构，并确保关键数组存在，防止前端白屏
 * @param {object} rawData 原始卡片数据
 * @param {boolean} [noClone] 批量加载路径优化：入参为每次新 parse 的对象（用完即弃），
 *    可原地规范化省掉 1 万次 structuredClone 深拷贝（真实大库解析 CPU 大头）；
 *    用户编辑/持久化的数据路径勿传此参数（保持深拷贝防污染）
 * @returns {object} 规范化后的 V2 结构
 */
export function normalizeCardData(rawData, noClone = false) {
    // 🔧 纯函数化：深拷贝后再规范化，杜绝原地修改入参造成的跨引用污染
    // （同一 parsedData 可能同时被 library 旧引用持有；structuredClone 对 JSON 派生对象零损耗）
    // 🚀 v2.3 优化：noClone 路径（批量加载）直接复用入参，省掉万次深拷贝
    let card = (rawData && typeof rawData === 'object' && !Array.isArray(rawData))
        ? (noClone ? rawData : structuredClone(rawData))
        : {};

    if (!card.spec && card.data && typeof card.data === 'object') {
        card.spec = 'chara_card_v2';
        card.spec_version = '2.0';
    } else if (!card.spec && !card.data) {
        card = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { ...card }
        };
    }

    if (card.data) {
        card.data.tags = Array.isArray(card.data.tags) ? card.data.tags : [];
        card.data.alternate_greetings = Array.isArray(card.data.alternate_greetings) ? card.data.alternate_greetings : [];
        card.data.extensions = card.data.extensions || {};
    }

    return card;
}

/**
 * 安全提取角色卡内嵌世界书条目数组（全形态兼容，杜绝脏数据崩溃）
 *
 * 修复「导入 JSON 角色卡后侧边栏消失/白屏」的根因：character_book 的形态陷阱
 *   ① entries 为字典对象（SillyTavern 世界书标准形态 { "0": {...}, "1": {...} }）
 *     → 旧写法 `book.entries || (Array.isArray(book) ? book : [])` 拿到字典，
 *       后续 .forEach/.filter 直接 TypeError → computed 崩溃 → 侧边栏（角色栏）消失；
 *   ② character_book 本身是数组（老 V1 嵌入形态）
 *     → 数组自带 Array.prototype.entries 方法（truthy 函数），同样短路旧判断拿到函数，
 *       .forEach 崩溃；且 JSON.stringify(函数) 返回 undefined，链式 .toLowerCase() 崩溃。
 *
 * 统一规则：数组 book 优先识别（避开原型方法陷阱）→ entries 数组 → entries 字典（Object.values）
 *
 * @param {object|Array} book 卡片的 character_book 字段（任意脏形态，含 null/undefined）
 * @returns {Array<object>} 条目数组（null/非对象脏条目已过滤；异常形态返回 []，永不抛错）
 */
export function extractBookEntries(book) {
    if (!book) return [];
    // 形态②：book 本身就是条目数组（老 V1 嵌入形态）——必须在读取 .entries 前判断，
    // 否则数组自带的 entries 原型方法（函数）会被误当作条目集合
    if (Array.isArray(book)) return book.filter(e => e && typeof e === 'object');
    if (typeof book !== 'object') return [];
    const raw = book.entries;
    // 形态①标准：entries 是数组
    if (Array.isArray(raw)) return raw.filter(e => e && typeof e === 'object');
    // 形态①兼容：entries 是字典（SillyTavern 世界书导出形态）
    if (raw && typeof raw === 'object') return Object.values(raw).filter(e => e && typeof e === 'object');
    return [];
}

/**
 * 🕵️ 角色卡血统严格鉴定（纯函数，从 App.vue 迁入）：
 * 过滤伪装成卡片的聊天记录、独立世界书、UI 主题配置、config.json 等系统配置
 * 与无内容字段的杂物，防止污染卡片库。
 * @param {object} data 待鉴定的解析后 JSON 对象
 * @returns {boolean} 是否为合法角色卡数据
 */
export function isCharacterCardData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;

    // 🚫 绝对拦截①：聊天记录（酒馆聊天导出常为数组，或含 messages / chat_metadata 字段）
    if (data.messages || data.chat_metadata) return false;

    // 🚫 绝对拦截②：独立世界书 —— 任何形态的 entries 都是世界书特征（数组 / 对象字典 / 字符串），
    //    以及 data.entries 嵌套结构（非 character_book），一律拦截。
    //    角色卡的世界书永远只在 data.character_book / data.data.character_book 内，绝不会是顶层或 data.entries。
    if (data.entries !== undefined) return false;
    if (data.data && typeof data.data === 'object' &&
        'entries' in data.data && !data.data.character_book) return false;

    // 🚫 绝对拦截③：酒馆 UI 主题 / 界面配置 JSON
    if (data.colors || data.user_settings) return false;

    // V2/V3：spec 标记（chara_card_v2/v3）且带 data 对象
    if (typeof data.spec === 'string' && /^chara_card_v[23]$/i.test(data.spec.trim())) {
        return !!(data.data && typeof data.data === 'object');
    }
    // V1 / Character.ai 格式：必须有角色名 + 至少一个内容字段
    if (typeof data.name === 'string' && data.name.trim() !== '') {
        // ✅ [补丁] 增加更严格的排他条件：酒馆 config.json 等标准配置文件即使带 name 也直接抛弃，
        // 防止其被误当成 V1 角色卡混入库中
        if (data.system_settings || data.api_keys || data.public_api) return false;

        return typeof data.description === 'string' ||
               typeof data.personality === 'string' ||
               typeof data.first_mes === 'string' ||
               typeof data.scenario === 'string' ||
               typeof data.mes_example === 'string';
    }
    return false;
}

/**
 * 🕵️ 卡片血统鉴定的拒绝原因诊断（配合 isCharacterCardData，日志可解释"为什么跳过"）
 * 万卡库实测：被拒 JSON 主要是 ①独立世界书(entries) ②酒馆快速回复集(QR，disableSend/injectInput)
 * ③配套文件(API配置/破限/正则) ④UI 主题配置 ⑤聊天记录 ⑥无内容字段的杂物。
 */
export function getCardRejectReason(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return '非对象数据';
    if (data.messages || data.chat_metadata) return '聊天记录导出';
    if (data.entries !== undefined) return '独立世界书(顶层 entries)';
    if (data.data && typeof data.data === 'object' &&
        'entries' in data.data && !data.data.character_book) return '独立世界书(data.entries)';
    if (data.colors || data.user_settings) return 'UI 主题配置';
    if (typeof data.name === 'string' && data.name.trim() !== '') {
        if (data.system_settings || data.api_keys || data.public_api) return '酒馆配置文件(config)';
        if (data.apiType !== undefined || data.openAIKey !== undefined || data.jailbreak !== undefined) return '破限/API 配置文件';
        if (data.disableSend !== undefined || data.injectInput !== undefined || data.placeBeforeInput !== undefined) return '快速回复集(QR)';
        if (data.type && !/^chara_card/i.test(String(data.type))) return '自定义类型文件';
        return '缺少角色内容字段(description/personality/first_mes 等)';
    }
    if (typeof data.spec === 'string') return '未知 spec 版本';
    if (data.type) return '自定义类型文件';
    return '无角色名且无 spec 标记';
}

/**
 * 自动贴标签规则（v2.1 升级：系统预设集合 + 用户自定义）
 * - defaultAutoTagRules：系统内置预设规则集合（分 group，默认全部生效，随应用内置）
 *   —— 用户无需逐条添加，它们已经在系统里；UI 分组展示供查看。
 * - compileAutoTagRules(custom)：编译 = 系统预设全部 + 用户自定义（[{name, regex}]，同名覆盖）
 * 消费方：useCardCrud（导入自动分类）与 useAITools（AI 打标三层漏斗第一层），规则由 App.vue 注入。
 */
export const defaultAutoTagRules = [
    // ── 世界观 / 题材 ──
    { name: 'Fantasy (奇幻)', regex: '魔法|精灵|异世界|巨龙|魔王|骑士', group: '世界观/题材' },
    { name: 'Sci-Fi (科幻)', regex: '星系|机甲|赛博朋克|AI|未来', group: '世界观/题材' },
    { name: '末世/废土', regex: '末世|废土|丧尸|末日|辐射', group: '世界观/题材' },
    { name: '克苏鲁/恐怖', regex: '克苏鲁|洛夫克拉夫特|不可名状|恐怖|惊悚|san值', group: '世界观/题材' },
    { name: '悬疑/推理', regex: '悬疑|推理|侦探|案件|谜案|刑侦|真相', group: '世界观/题材' },
    { name: '仙侠/修真', regex: '仙侠|修真|修仙|元婴|渡劫|灵气|飞升|宗门', group: '世界观/题材' },
    { name: '武侠/江湖', regex: '武侠|江湖|武林|门派|内力|剑客|侠客|暗器', group: '世界观/题材' },
    { name: '古代/宫廷', regex: '古代|王朝|宫廷|皇帝|皇后|将军|妃嫔|历史', group: '世界观/题材' },
    { name: '现代/都市', regex: '都市|现代|职场|公司|总裁|白领|上班族', group: '世界观/题材' },
    { name: '校园/学园', regex: '校园|学园|学校|班级|老师|同学|社团|学生会', group: '世界观/题材' },
    { name: '穿越/重生', regex: '穿越|重生|回到过去|预知未来|系统', group: '世界观/题材' },
    { name: '游戏/异世界', regex: '游戏|异世界|副本|等级|技能|冒险者|地下城|rpg', group: '世界观/题材' },
    { name: '机甲/战舰', regex: '机甲|高达|驾驶员|机体|战舰|宇宙|外星|星际', group: '世界观/题材' },
    // ── 种族 / 物种 ──
    { name: '精灵/妖精', regex: '精灵|妖精|森之|精灵族|尖耳', group: '种族/物种' },
    { name: '恶魔/天使', regex: '恶魔|天使|堕天使|撒旦|地狱|天堂|魔界', group: '种族/物种' },
    { name: '吸血鬼/狼人', regex: '吸血鬼|血族|狼人|狼族|月圆|獠牙', group: '种族/物种' },
    { name: '兽人/福瑞', regex: '兽人|福瑞|兽耳|尾巴|furry|亚人', group: '种族/物种' },
    { name: '魔物娘/人外', regex: '魔物娘|触手|史莱姆|魅魔|人外|蛇女', group: '种族/物种' },
    { name: '机器人/仿生人', regex: '机器人|仿生人|人造人|人工智能|机械', group: '种族/物种' },
    { name: '幽灵/妖怪', regex: '幽灵|鬼|怨灵|妖怪|阴阳师|式神|灵异', group: '种族/物种' },
    { name: '龙/龙裔', regex: '巨龙|龙族|龙裔|龙王|白龙|龙人', group: '种族/物种' },
    // ── 人物类型 ──
    { name: '魔法/骑士', regex: '魔法|骑士|法师|魔导师|剑士|圣骑士|魔女', group: '人物类型' },
    { name: '黑帮/犯罪', regex: '黑帮|黑道|黑手党|犯罪|杀手|雇佣兵|地下势力', group: '人物类型' },
    { name: '军人/特工', regex: '军人|特种兵|特工|军官|狙击手|士兵|指挥官', group: '人物类型' },
    { name: '警察/侦探', regex: '警察|刑警|侦探|探员|警官|缉毒', group: '人物类型' },
    { name: '医生/护士', regex: '医生|护士|外科|医院|治疗|急救', group: '人物类型' },
    { name: '老师/师生', regex: '教师|老师|师生|教授|讲师|班主任', group: '人物类型' },
    { name: '偶像/明星', regex: '偶像|明星|歌手|演员|idol|艺人|练习生', group: '人物类型' },
    { name: '神明/神话', regex: '神明|神祇|神话|希腊|北欧|奥林匹斯|神格|巫女', group: '人物类型' },
    { name: '公主/贵族', regex: '公主|千金|大小姐|王室|贵族|伯爵|侯爵|骑士团', group: '人物类型' },
    // ── 性格 / 关系 ──
    { name: 'NSFW (限制级)', regex: 'nsfw|18\\+|r18|色情|淫乱', group: '性格/关系' },
    { name: 'Romance (恋爱)', regex: '恋爱|傲娇|病娇|青梅竹马', group: '性格/关系' },
    { name: '傲娇/毒舌', regex: '傲娇|毒舌|口是心非|别扭', group: '性格/关系' },
    { name: '病娇/黑化', regex: '病娇|黑化|占有欲|偏执|疯狂', group: '性格/关系' },
    { name: '青梅竹马', regex: '青梅竹马|竹马|童年玩伴|邻居|发小', group: '性格/关系' },
    { name: '纯爱/温馨', regex: '纯爱|温馨|治愈|日常|甜|暖暖', group: '性格/关系' },
    { name: '后宫/修罗场', regex: '后宫|逆后宫|多人|修罗场', group: '性格/关系' },
    { name: '主仆/女仆', regex: '主仆|女仆|管家|佣人|臣服|主人', group: '性格/关系' }
];

// 📚 自定义规则添加时的常用关键词候选（点击追加到正则输入框，免手写）
export const autoTagKeywordCandidates = [
    '魔法', '精灵', '异世界', '巨龙', '魔王', '骑士', '末世', '废土', '丧尸', '克苏鲁',
    '悬疑', '侦探', '仙侠', '修真', '修仙', '武侠', '江湖', '古代', '宫廷', '皇帝',
    '都市', '职场', '校园', '老师', '穿越', '重生', '系统', '赛博朋克', '机甲', '科幻',
    '吸血鬼', '狼人', '恶魔', '天使', '兽人', '魅魔', '触手', '人外', '机器人', '仿生人',
    '幽灵', '妖怪', '龙', '忍者', '黑帮', '杀手', '军人', '特工', '警察', '医生',
    '护士', '偶像', '歌手', '神明', '神话', '公主', '贵族', '千金', '傲娇', '病娇',
    '青梅竹马', '纯爱', '治愈', '后宫', '主仆', '女仆', '恋爱', 'ntr', '虐心', '调教'
];

// 编译规则：系统预设全部 + 用户自定义（[{name, regex}]，同名覆盖系统预设）
// ⚠️ 逐条 try/catch：单条正则非法只跳过该条，不拖垮整表。
export function compileAutoTagRules(customRules) {
    const out = {};
    // 1) 系统预设（默认全部生效，无需用户逐个添加）
    for (const r of defaultAutoTagRules) {
        try { out[r.name] = new RegExp(r.regex, 'i'); } catch (e) { /* 系统预设正则非法跳过 */ }
    }
    // 2) 用户自定义（追加 / 同名覆盖）
    if (Array.isArray(customRules)) {
        for (const item of customRules) {
            if (item && typeof item.name === 'string' && item.name.trim()
                && typeof item.regex === 'string' && item.regex.trim()) {
                try { out[item.name.trim()] = new RegExp(item.regex.trim(), 'i'); } catch (e) { /* 非法跳过 */ }
            }
        }
    }
    return out;
}

// 兼容旧引用：系统预设编译结果（useCardCrud/useAITools 已改为注入，此导出仅供兜底/单测）
export const autoTagRules = compileAutoTagRules(null);

/**
 * 读取并解析角色卡文件
 * @param {File} file 用户选择的文件（.json / .png / .webp / .jpeg / .jpg）
 * @returns {Promise<{data: object, imgUrl: string|null, file: File}>} 解析结果
 * @throws {Error} 抛出带错误码（message）的错误，用于上层提示：
 *   - 'NO_CARD_DATA'：未能提取到有效的角色卡数据
 */
export async function processFile(file) {
    try {
        let parsedData = null;
        let url = null;

        if (file.name.toLowerCase().endsWith('.json')) {
            const text = await file.text();
            parsedData = JSON.parse(text);
        } else {
            // 图片处理（PNG、WebP 等）
            // 修复缺陷3：Electron 架构优先用本地路径协议（零 Blob 内存占用）；
            // 纯 Web/浏览器 File 无 path 时才降级 ObjectURL（由上层组件销毁时 revoke）
            url = file.path
                ? `local-file://img/?path=${encodeURIComponent(file.path)}`
                : URL.createObjectURL(file);

            const buffer = await file.arrayBuffer();

            // 1. 先尝试标准 PNG 数据块解析
            parsedData = parsePNGChunk(buffer);

            // 2. 失败时（WebP 或非标准）进行深度扫描
            if (!parsedData) {
                parsedData = deepScanForJSON(buffer);
            }
        }

        if (parsedData) {
            // 将 file 一起返回，方便上层组件统一处理 URL 回收或路径绑定
            return { data: normalizeCardData(parsedData), imgUrl: url, file };
        }

        // 解析失败时的内存清理（仅回收 blob: 链接，local-file:// 无需回收）
        if (url && url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }

        throw new Error('NO_CARD_DATA');
    } catch (error) {
        console.error(`解析卡片 [${file.name}] 失败:`, error);
        throw error;
    }
}
