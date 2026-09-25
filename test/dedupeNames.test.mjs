import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normName, extractNameStem, tailCandidates, discoverTails, applyTails,
    lcsLen, nameSimRaw, sameName,
} from '../js/utils/dedupeNames.js';

/** v4 §7 —— 名字层单测（形状剥离 / 语料统计 / 单字主干保护 / 相似度） */

// ── 规范化与形状剥离 ─────────────────────────────────────────

test('normName：NFKC + lower + 去空白/标点/符号', () => {
    assert.equal(normName(' 唐 清-露 '), '唐清露');
    assert.equal(normName('ＡＢＣ_01'), 'abc_01'.replace('_', ''));
    assert.equal(normName(null), '');
});

test('extractNameStem：版本号（含 CJK 邻接）与副本形态剥离', () => {
    const s1 = extractNameStem('唐清露 2.2版');
    assert.equal(s1.stem0, '唐清露版');
    assert.ok(s1.stripped.includes('2.2'));

    const s2 = extractNameStem('鬼 1.1版'); // 单字主干：形状层剥离照做，保护在语料层（见下）
    assert.equal(s2.stem0, '鬼版');

    assert.equal(extractNameStem('观星者_20250925').stem0, '观星者');
    assert.equal(extractNameStem('观星者 copy2').stem0, '观星者');
    assert.equal(extractNameStem('观星者 (1)').stem0, '观星者');
    assert.equal(extractNameStem('青云 2.0 (1)').stem0, '青云');
    assert.equal(extractNameStem('').stem0, '');
});

test('tailCandidates：中文尾缀候选（1~4 字）与**单字主干保护**', () => {
    const c1 = tailCandidates('唐清露版');
    assert.ok(c1.some(([h, t]) => h === '唐清露' && t === '版'));
    // 单字主干（head='鬼'）不得产出候选 —— 评审微调 #1
    assert.deepEqual(tailCandidates('鬼版'), []);
    assert.deepEqual(tailCandidates('短'), []);
});

// ── 语料统计（数据驱动） ─────────────────────────────────────

test('discoverTails：跨主干频次 ≥ K_tail 才登记（K_tail=3）', () => {
    const names = ['清风细雨版', '明月高悬版', '流水潺潺版', '落霞孤鹜版'];
    const tails = discoverTails(names);
    assert.ok(tails.has('版'), `未发现尾缀「版」：${[...tails]}`);
    const few = discoverTails(['清风细雨版', '明月高悬版']); // 仅 2 个不同主干
    assert.ok(!few.has('版'), '不足 K_tail 不应登记');
});

test('applyTails：剥离已登记尾缀；**单字主干保护**在语料层同样是铁律', () => {
    const tails = new Set(['版']);
    assert.equal(applyTails('清风细雨版', tails).stemFinal, '清风细雨');
    assert.equal(applyTails('唐清露版', tails).stemFinal, '唐清露');
    // '鬼版' 剥后主干仅 1 字 → 拒绝剥离（原样返回）
    assert.equal(applyTails('鬼版', tails).stemFinal, '鬼版');
    assert.equal(applyTails('清风细雨', tails).stemFinal, '清风细雨');
});

// ── 相似度（仅候选与展示用） ─────────────────────────────────

test('lcsLen：最长公共子串', () => {
    assert.equal(lcsLen('abcd', 'xbcdy'), 3);
    assert.equal(lcsLen('abc', 'def'), 0);
    assert.equal(lcsLen('', 'abc'), 0);
});

test('nameSimRaw：互相包含=1；部分重合按 LCS/较短；空 → null（无法判定不否决）', () => {
    assert.equal(nameSimRaw('神里氏 长女', '神里氏 长女 改'), 1);
    assert.equal(nameSimRaw('绪月', '绪翮'), 0.5);
    assert.equal(nameSimRaw('神里氏', '纳西妲'), 0);
    assert.equal(nameSimRaw('', 'x'), null);
    assert.equal(nameSimRaw(null, null), null);
});

test('sameName：规范化后精确同名', () => {
    assert.equal(sameName(' 神里-氏 ', '神里氏'), true);
    assert.equal(sameName('神里氏', '神里氏 改'), false);
    assert.equal(sameName('', ''), false);
});
