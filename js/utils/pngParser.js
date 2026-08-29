/**
 * 图片解析工具
 * 支持标准 PNG tEXt / iTXt 数据块解析，以及对 WebP / 损坏 PNG 的深度扫描提取。
 */

/**
 * 稳健地解码 Base64，正确处理 UTF-8 字符
 * @param {string} base64 Base64 字符串
 * @returns {string} 解码后的字符串
 */
export function decodeBase64UTF8(base64) {
    // 🔧 代码审查修复 7：废弃 escape() → TextDecoder 标准解码（无非 ASCII 越界隐患）
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * 从图片缓冲区中深度扫描提取有效 JSON（适用于 WebP 与损坏的 PNG）
 * @param {ArrayBuffer} buffer 图片文件缓冲区
 * @returns {object|null} 提取到的角色卡数据，未找到时返回 null
 */
export function deepScanForJSON(buffer) {
    const bytes = new Uint8Array(buffer);
    // 【性能修复】用 latin1 一次性转码，替代逐字节字符串拼接（O(N²) 内存灾难，
    // 5MB 大图会执行 500 万次拼接导致主线程卡死/内存狂飙）
    const binary = new TextDecoder('latin1').decode(bytes);

    // 匹配以 eyJ（即 '{"' 的 Base64 编码）开头的 Base64 块
    const base64Regex = /(eyJ[A-Za-z0-9+/=]+)/g;
    const matches = binary.match(base64Regex);

    if (matches) {
        // 按长度降序排列，优先尝试最可能是完整载荷的匹配
        matches.sort((a, b) => b.length - a.length);
        for (const match of matches) {
            try {
                const decoded = decodeBase64UTF8(match);
                const parsed = JSON.parse(decoded);
                if (parsed.name || (parsed.data && parsed.data.name)) {
                    return parsed;
                }
            } catch (e) {
                continue;
            }
        }
    }

    // 纯 JSON 文本扫描兜底（【修复】杜绝贪婪正则对超大二进制的灾难性回溯）
    // 策略：① 先扫描前 1MB（防止整图暴力匹配）；② 用 indexOf/lastIndexOf 线性定位 + 花括号
    //    深度配平，完全避免回溯；③ 🚀 v2.0：1MB 窗口未命中且文件更大时，做整文件兜底扫描，
    //    保证超大 WebP/损坏 PNG 卡（内嵌大世界书/正则）不再静默丢失。
    const tryScanJsonText = (searchable, maxEndCap) => {
        const nameIdx = searchable.indexOf('"name"');
        if (nameIdx === -1) return null;
        const start = searchable.lastIndexOf('{', nameIdx);
        if (start === -1) return null;
        // 从 start 的 '{' 起，向后做花括号深度配平，找到完整 JSON 结尾
        let depth = 0;
        let end = -1;
        const maxEnd = Math.min(searchable.length, start + maxEndCap);
        for (let i = start; i < maxEnd; i++) {
            const ch = searchable[i];
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { end = i; break; }
            }
        }
        if (end <= start) return null;
        try {
            const parsed = JSON.parse(searchable.slice(start, end + 1));
            if (parsed.name || parsed.data) return parsed;
        } catch (e) { /* 忽略解析失败 */ }
        return null;
    };

    // 第一轮：前 1MB 窗口 + 500KB 配平上限（快速路径，覆盖绝大多数卡）
    const headWindow = Math.min(binary.length, 1024 * 1024);
    let found = tryScanJsonText(binary.slice(0, headWindow), 500 * 1024);
    // 第二轮（大卡兜底）：整文件扫描 + 8MB 配平上限（受文件大小保护，超大卡不再丢）
    if (!found && binary.length > 1024 * 1024) {
        found = tryScanJsonText(binary, 8 * 1024 * 1024);
    }
    if (found) return found;

    return null;
}

/**
 * 标准 PNG tEXt / iTXt 数据块解析器
 * @param {ArrayBuffer} buffer PNG 文件缓冲区
 * @returns {object|null} 解析出的角色卡数据，非 PNG 或未找到时返回 null
 */
export function parsePNGChunk(buffer) {
    const view = new DataView(buffer);
    if (view.getUint32(0) !== 0x89504E47) return null; // 非 PNG 文件

    let offset = 8;
    while (offset < buffer.byteLength) {
        try {
            const length = view.getUint32(offset);
            const type = String.fromCharCode(
                view.getUint8(offset + 4), view.getUint8(offset + 5),
                view.getUint8(offset + 6), view.getUint8(offset + 7)
            );

            if (type === 'tEXt' || type === 'iTXt') {
                const chunkData = new Uint8Array(buffer, offset + 8, length);
                const nullPos = chunkData.indexOf(0);
                const keyword = new TextDecoder().decode(chunkData.slice(0, nullPos));

                if (keyword === 'chara' || keyword === 'ccv3') {
                    // 兼容 V2(chara) / V3(ccv3) 两种数据块关键字；
                    // tEXt 为 latin1（或 Base64 字符串），iTXt 为 utf-8
                    // 【修复】iTXt 结构：keyword\0 compression_flag(1) compression_method(1)
                    //   language_tag\0 translated_keyword\0 text —— 必须跳过语言标签与译名关键词两个 \0 终止段，
                    //   文本起点才是真正的正文（旧代码 nullPos+3 定位到语言标签区，标准 iTXt 卡解析失败）
                    let textStart;
                    if (type === 'iTXt') {
                        let p = nullPos + 1; // 跳过 keyword\0
                        p += 2;              // 跳过 compression_flag + compression_method
                        const langEnd = p < chunkData.length ? chunkData.indexOf(0, p) : -1; // language_tag 以 \0 结束
                        if (langEnd === -1) {
                            textStart = chunkData.length; // 结构异常，无文本可读
                        } else {
                            const trEnd = chunkData.indexOf(0, langEnd + 1); // translated_keyword 以 \0 结束
                            textStart = trEnd === -1 ? chunkData.length : trEnd + 1;
                        }
                    } else {
                        textStart = nullPos + 1; // tEXt：keyword\0 text
                    }
                    const textData = new TextDecoder('utf-8').decode(chunkData.slice(textStart));
                    const base64Str = textData.replace(/\0/g, ''); // 清理空字节
                    const jsonStr = decodeBase64UTF8(base64Str);
                    return JSON.parse(jsonStr);
                }
            }
            offset += 12 + length;
        } catch (e) {
            break;
        }
    }
    return null;
}
