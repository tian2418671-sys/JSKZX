'use strict';
/**
 * 🛡️ 保存闸门：拒绝「正文集体变空」的写入（PK-32，2026-09-25）
 *
 * ─────────────────────────────────────────────────────────────
 * 🐞 为什么需要它（实测事故链）
 * ─────────────────────────────────────────────────────────────
 * P1a 正文懒加载（`js/utils/cardSlim.js`）会把**卡内世界书词条正文清空**省内存 ——
 * 真实 11k 库实测 **9,557 / 11,186 张**处于该状态。而渲染层的「批量贴标签 / AI 打标后落盘」
 * 走的是 `useCardCrud.persistCardUpdate` → `window.electronAPI.saveCard(path, item.data)`，
 * 传的就是**这份瘦身态 payload**：
 *
 *   CDP 实测（运行中的真实 11k 库，只读）：`- juus - (2).png` = `_slim: true` / `_bookCount: 54`
 *   ⇒ 内存「54 条词条，**非空 0 条**」⇒ 复算将送出的 payload：`entries 54 / nonEmpty 0`。
 *
 * 而 `main.js file:saveCard` 过去**原样内嵌**（只 `stripInternalFields`，不与磁盘比对）
 * ⇒ 对瘦身库里的卡改一次标签，就会把**该卡整本内嵌世界书的正文抹掉**。
 * 既有设计早预言过这个风险（`CHANGELOG` v2.2.7（五）：「读失败即拒绝打开，
 * **否则编辑器空字段一保存就把卡写空**」），但保护只做在「打开卡」这一条路上。
 *
 * ─────────────────────────────────────────────────────────────
 * 判据（**只拦「集体变空」**，不拦正常编辑）
 * ─────────────────────────────────────────────────────────────
 *   磁盘旧卡 **有**正文（oldN > 0） 且 本次 payload **一条都没有**（newN === 0） ⇒ 拒写
 * 其余情况一律放行：旧卡本来就没正文 / payload 仍有正文 / 用户真的逐条删（很少会归零）。
 *
 * ⚠️ 本模块**只做判定**，不读盘、不写盘 —— 便于单测（`test/cardBodyGuard.test.mjs`
 *    用**真实卡片**做样本：真卡原样 ⇒ 放行；真卡按运行期瘦身形态清空 ⇒ 拒写）。
 * ⚠️ 与渲染层的 `ensureFullBody`（保存前读回正文）构成**双保险**：
 *    前端拿全 → 正常保存；前端漏了 → 本闸门兜底。
 */

/** 取「卡数据层」：主进程收到的是**文件内嵌 JSON**（`{spec, data:{…}}`），渲染层传的是 `item.data`；
 *  两者都可能是「包一层」的形态 ⇒ 找不到 `character_book` 时**再往里探一层**（防御性，不影响正常形态）。 */
function payloadLayerOf(card) {
    let d = (card.data && typeof card.data === 'object') ? card.data : card;
    if (!d.character_book && d.data && typeof d.data === 'object' && d.data.character_book) d = d.data;
    return d;
}

/** 一张卡里「有正文的词条数 + 非空附加问候语数」 */
function countNonEmptyBodies(card) {
    if (!card || typeof card !== 'object') return 0;
    const d = payloadLayerOf(card);
    const book = d.character_book || card.character_book || null;
    let list = [];
    if (book) {
        // ⚠️ 脏形态兼容（三道，缺一不可）：
        //   ① `book` 本身是数组（V1 嵌入形态）—— **必须先判数组**：
        //      数组有原型方法 `.entries`，`book.entries !== undefined` 会拿到**函数**，
        //      于是数出 0 条 → 闸门失效（项目里已踩过同款坑：extractBookEntries 的注释）
        //   ② `entries` 是数组（V2/V3 标准形态）
        //   ③ `entries` 是对象字典（SillyTavern 旧导出形态）
        const e = Array.isArray(book) ? book : ((book.entries !== undefined) ? book.entries : book);
        if (Array.isArray(e)) list = e;
        else if (e && typeof e === 'object') list = Object.values(e);
    }
    let n = 0;
    for (const e of list) {
        if (e && typeof e === 'object' && typeof e.content === 'string' && e.content.length) n++;
    }
    const ag = d.alternate_greetings || card.alternate_greetings;
    if (Array.isArray(ag)) {
        for (const g of ag) if (typeof g === 'string' && g.length) n++;
    }
    return n;
}

/**
 * @param {object|null} oldCard 磁盘上的旧卡（PNG 内嵌块 / JSON 解析结果）
 * @param {object} newPayload   本次要写入的卡数据
 * @returns {string|null} null = 放行；字符串 = 拒绝原因（面向用户）
 */
function checkBodyDegrade(oldCard, newPayload) {
    const oldN = countNonEmptyBodies(oldCard);
    if (oldN <= 0) return null;                      // 旧卡本来就没正文 → 放行（零成本）
    const newN = countNonEmptyBodies(newPayload);
    if (newN > 0) return null;                       // 仍然有正文 → 放行
    return '检测到本次保存会把该卡的全部正文（词条内容 / 附加问候语）清空，已中止保存 ——\n'
        + `原文件未被改动（磁盘上原有 ${oldN} 处非空正文）。\n\n`
        + '常见原因：卡片当前处于「列表瘦身态」（大库省内存时词条正文会被临时释放），\n'
        + '而本次保存没有先读回正文。请重新打开这张卡（会自动读回正文）后再保存；\n'
        + '若你确实想清空全部内容，请逐条删除后保存。';
}

module.exports = { countNonEmptyBodies, checkBodyDegrade };
