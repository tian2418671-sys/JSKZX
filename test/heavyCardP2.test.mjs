/**
 * 🎬 重型卡 P2 · 单测
 * 覆盖：离线白名单判定 / tar 打包解包往返 / 路径穿越防护
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// ⚠️ manager.js / backup.js 是 CommonJS ⇒ 必须默认导入后解构，
//    不能用 `import { x } from`（Node 对 CJS 的命名导出探测不可靠）。
import managerPkg from '../main/heavyCards/manager.js';
const { isAllowedRequest } = managerPkg;
import backupPkg from '../main/heavyCards/backup.js';
const {
    createHeavyCardBackupService,
    buildTarHeader,
    readTarEntries,
    partitionDirOf,
    BACKUP_ROOT_NAME
} = backupPkg;

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hc-p2-test-'));
}
function rmrf(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

// ─────────────────────────── 离线模式 ───────────────────────────

test('isAllowedRequest：同域名与其子域放行', () => {
    assert.equal(isAllowedRequest('https://jfdk.xxbjf.com/a.js', 'jfdk.xxbjf.com', []), true);
    assert.equal(isAllowedRequest('https://cdn.jfdk.xxbjf.com/a.js', 'jfdk.xxbjf.com', []), true);
});

test('isAllowedRequest：第三方域名被拒', () => {
    assert.equal(isAllowedRequest('https://evil.com/track.png', 'jfdk.xxbjf.com', []), false);
    assert.equal(isAllowedRequest('https://api.openai.com/v1/chat', 'jfdk.xxbjf.com', []), false);
});

test('isAllowedRequest：白名单生效（含通配前缀）', () => {
    assert.equal(isAllowedRequest('https://api.openai.com/v1', 'jfdk.xxbjf.com', ['api.openai.com']), true);
    assert.equal(isAllowedRequest('https://sub.foo.com/x', 'jfdk.xxbjf.com', ['*.foo.com']), true);
});

test('isAllowedRequest：内部协议一律放行', () => {
    for (const u of ['app://index.html/x', 'local-file://img/?path=a', 'data:text/plain,1', 'blob:app://x']) {
        assert.equal(isAllowedRequest(u, 'a.com', []), true, u);
    }
});

test('isAllowedRequest：非 http 协议放行（避免误伤 ws）', () => {
    assert.equal(isAllowedRequest('ws://jfdk.xxbjf.com/ws', 'other.com', []), true);
});

test('isAllowedRequest：非法 URL 被拒', () => {
    assert.equal(isAllowedRequest('http://', 'a.com', []), false);
});

// ─────────────────────────── tar 打包 ───────────────────────────

test('buildTarHeader：512 字节 + ustar 魔数 + 校验和正确', () => {
    const h = buildTarHeader('a/b.txt', 5, 1700000000);
    assert.equal(h.length, 512);
    assert.equal(h.slice(257, 262).toString('utf8'), 'ustar');
    // 校验和：把 chksum 区当空格重算，应与头部记录一致
    const copy = Buffer.from(h);
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += copy[i];
    const recorded = parseInt(h.slice(148, 154).toString('utf8').trim(), 8);
    assert.equal(recorded, sum);
});

test('buildTarHeader：超出 100 字节的路径拆到 prefix', () => {
    const longName = 'a'.repeat(90) + '/' + 'b'.repeat(90) + '/file.txt';
    const h = buildTarHeader(longName, 1, 0);
    const name = h.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = h.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
    assert.ok(Buffer.byteLength(name, 'utf8') <= 100);
    assert.ok(prefix.length > 0);
});

test('exportBundle → readTarEntries 往返：中文文件名与内容完整', async () => {
    const root = tmpRoot();
    try {
        // 造 partition + 一份备份
        const dir = partitionDirOf(root, 'hc_p2', 1);
        const ls = path.join(dir, 'Local Storage', 'leveldb');
        fs.mkdirSync(ls, { recursive: true });
        fs.writeFileSync(path.join(ls, 'CURRENT'), 'MANIFEST-1');
        fs.writeFileSync(path.join(ls, '000003.log'), 'hello 中文内容');

        const svc = createHeavyCardBackupService({ userDataPath: root });
        const bk = await svc.createBackup({ cardId: 'hc_p2', gen: 1, kind: 'manual' });
        assert.equal(bk.success, true, JSON.stringify(bk));

        const out = path.join(root, 'bundle.tar');
        const exp = svc.exportBundle({ cardId: 'hc_p2', backupName: bk.name, outFile: out });
        assert.equal(exp.success, true, JSON.stringify(exp));

        const entries = readTarEntries(fs.readFileSync(out));
        const names = entries.map((e) => e.name);
        assert.ok(names.includes('_manifest.json'), '必须含 manifest');
        assert.ok(names.some((n) => n.includes('000003.log')));
        const dataEntry = entries.find((e) => e.name.includes('000003.log'));
        assert.equal(dataEntry.data.toString('utf8'), 'hello 中文内容');
    } finally { rmrf(root); }
});

test('importBundle：导入为新快照，且拒绝无 manifest 的包', async () => {
    const root = tmpRoot();
    try {
        const dir = partitionDirOf(root, 'hc_p3', 1);
        const ls = path.join(dir, 'Local Storage', 'leveldb');
        fs.mkdirSync(ls, { recursive: true });
        fs.writeFileSync(path.join(ls, 'CURRENT'), 'x');

        const svc = createHeavyCardBackupService({ userDataPath: root });
        const bk = await svc.createBackup({ cardId: 'hc_p3', gen: 1, kind: 'manual' });
        const out = path.join(root, 'b.tar');
        svc.exportBundle({ cardId: 'hc_p3', backupName: bk.name, outFile: out });

        // 导到另一张卡
        const imp = svc.importBundle({ cardId: 'hc_p3b', inFile: out });
        assert.equal(imp.success, true, JSON.stringify(imp));
        const list = svc.listBackups('hc_p3b');
        assert.equal(list.length, 1);

        // 无 manifest 的包必须被拒
        const bad = path.join(root, 'bad.tar');
        const data = Buffer.from('x');
        fs.writeFileSync(bad, Buffer.concat([
            buildTarHeader('other.txt', data.length, 0), data,
            Buffer.alloc((512 - (data.length % 512)) % 512, 0),
            Buffer.alloc(1024, 0)
        ]));
        const r = svc.importBundle({ cardId: 'hc_p3b', inFile: bad });
        assert.equal(r.success, false);
        assert.match(r.error, /manifest/);
    } finally { rmrf(root); }
});

test('importBundle：路径穿越条目被跳过', async () => {
    const root = tmpRoot();
    try {
        const svc = createHeavyCardBackupService({ userDataPath: root });
        const out = path.join(root, 'evil.tar');
        const manifest = Buffer.from(JSON.stringify({ schema: 1, cardId: 'hc_x', createdAt: new Date().toISOString(), kind: 'manual' }));
        const evil = Buffer.from('PWNED');
        const parts = [];
        const push = (name, data) => {
            parts.push(buildTarHeader(name, data.length, 0), data,
                Buffer.alloc((512 - (data.length % 512)) % 512, 0));
        };
        push('_manifest.json', manifest);
        push('../../escaped.txt', evil);
        parts.push(Buffer.alloc(1024, 0));
        fs.writeFileSync(out, Buffer.concat(parts));

        const r = svc.importBundle({ cardId: 'hc_x', inFile: out });
        assert.equal(r.success, true, JSON.stringify(r));
        // 穿越文件不得写到备份目录之外
        const escaped = path.join(path.dirname(root), 'escaped.txt');
        assert.equal(fs.existsSync(escaped), false, '不得写到备份目录外');
        assert.equal(fs.existsSync(path.join(root, BACKUP_ROOT_NAME, 'escaped.txt')), false);
    } finally { rmrf(root); }
});

test('exportBundle：没有备份时报错', () => {
    const root = tmpRoot();
    try {
        const svc = createHeavyCardBackupService({ userDataPath: root });
        const r = svc.exportBundle({ cardId: 'hc_none', outFile: path.join(root, 'x.tar') });
        assert.equal(r.success, false);
        assert.match(r.error, /没有可用备份/);
    } finally { rmrf(root); }
});
