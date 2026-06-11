#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');

// ============== 常量与配置 ==============
const APP_DIR = path.join(process.cwd(), '.filesync');
const LOG_DIR = path.join(APP_DIR, 'logs');
const BACKUP_DIR = path.join(APP_DIR, 'backups');
const PROFILE_FILE = path.join(APP_DIR, 'profiles.json');
const CHUNK_SIZE = 64 * 1024; // 64KB 块
const MODES = ['mirror', 'push', 'pull'];

ensureDir(APP_DIR);
ensureDir(LOG_DIR);
ensureDir(BACKUP_DIR);

// ============== 工具函数 ==============
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function formatDate(d) {
  d = d instanceof Date ? d : new Date(d);
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseSize(str) {
  if (!str) return Infinity;
  const m = str.toString().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?b?)$/i);
  if (!m) return Infinity;
  const n = parseFloat(m[1]);
  const u = (m[2] || 'b').toLowerCase().charAt(0);
  const map = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Math.floor(n * (map[u] || 1));
}

function parseDateStr(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function md5(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

function fileMD5(filePath) {
  const buf = fs.readFileSync(filePath);
  return md5(buf);
}

// ============== CLI 参数解析 ==============
function parseArgs(argv) {
  const args = { _: [], options: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let val;
      if (eq > 0) {
        val = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        val = argv[++i];
      } else {
        val = true;
      }
      args.options[key] = val;
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ============== 简易 glob 匹配 ==============
function globToRegex(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '.') {
      re += '\\.';
      i++;
    } else if (c === '/') {
      re += '/';
      i++;
    } else if ('+^$()[]{}|\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchGlob(file, pattern) {
  const f = file.replace(/\\/g, '/');
  const p = pattern.replace(/\\/g, '/');
  if (p.includes('/')) {
    return globToRegex(p.replace(/^\//, '')).test(f.replace(/^\//, '')) ||
           globToRegex(p).test('/' + f);
  }
  const parts = f.split('/');
  return parts.some(part => globToRegex(p).test(part));
}

// ============== .syncignore 解析 ==============
function parseSyncIgnore(dir) {
  const file = path.join(dir, '.syncignore');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const rules = [];
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    rules.push({ pattern: line, negate, dirOnly: line.endsWith('/') });
  }
  return rules;
}

function isIgnored(file, rules, baseDir) {
  if (!rules.length) return false;
  const rel = path.relative(baseDir, file).replace(/\\/g, '/');
  const isDir = fs.existsSync(file) && fs.statSync(file).isDirectory();
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (matchGlob(rel, rule.pattern) || matchGlob(rel + '/', rule.pattern)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

// ============== 文件扫描 ==============
function scanDir(dir, opts = {}) {
  const result = {};
  const ignoreRules = parseSyncIgnore(dir);
  const base = path.resolve(dir);

  function walk(curDir) {
    let entries;
    try { entries = fs.readdirSync(curDir, { withFileTypes: true }); }
    catch { return; }

    for (const e of entries) {
      const full = path.join(curDir, e.name);
      if (isIgnored(full, ignoreRules, base)) continue;

      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (opts.maxSize != null && stat.size > opts.maxSize) continue;
        if (opts.newerThan != null && stat.mtime < opts.newerThan) continue;

        if (opts.includes && opts.includes.length) {
          const rel = path.relative(base, full).replace(/\\/g, '/');
          const matched = opts.includes.some(p => matchGlob(rel, p));
          if (!matched) continue;
        }
        if (opts.excludes && opts.excludes.length) {
          const rel = path.relative(base, full).replace(/\\/g, '/');
          const excluded = opts.excludes.some(p => matchGlob(rel, p));
          if (excluded) continue;
        }

        const rel = path.relative(base, full).replace(/\\/g, '/');
        result[rel] = {
          path: full,
          relPath: rel,
          size: stat.size,
          mtime: stat.mtime.getTime()
        };
      }
    }
  }
  walk(base);
  return result;
}

// ============== 差异检测 ==============
function detectDiff(left, right, direction = 'push') {
  const added = [];
  const modified = [];
  const deleted = [];
  const same = [];

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  for (const key of leftKeys) {
    if (!(key in right)) {
      added.push({ relPath: key, from: direction === 'push' ? 'source' : 'target', ...left[key] });
    } else {
      const l = left[key], r = right[key];
      if (l.mtime !== r.mtime || l.size !== r.size) {
        modified.push({ relPath: key, from: direction === 'push' ? 'source' : 'target',
          source: direction === 'push' ? l : r, target: direction === 'push' ? r : l });
      } else {
        same.push({ relPath: key, ...l });
      }
    }
  }
  for (const key of rightKeys) {
    if (!(key in left)) {
      deleted.push({ relPath: key, from: direction === 'push' ? 'target' : 'source', ...right[key] });
    }
  }
  return { added, modified, deleted, same };
}

// ============== 进度条 ==============
class ProgressBar {
  constructor(total, label = '') {
    this.total = total;
    this.current = 0;
    this.label = label;
    this.bytes = 0;
    this.totalBytes = 0;
    this.start = Date.now();
    this.lastRender = 0;
  }
  inc(bytes = 0) {
    this.current++;
    this.bytes += bytes;
    this.render();
  }
  addBytes(bytes) {
    this.bytes += bytes;
    this.render();
  }
  setTotalBytes(b) { this.totalBytes = b; }
  render() {
    const now = Date.now();
    if (now - this.lastRender < 50 && this.current < this.total) return;
    this.lastRender = now;
    const pct = this.total ? (this.current / this.total) * 100 : 0;
    const w = 30;
    const filled = Math.round((pct / 100) * w);
    const bar = '█'.repeat(filled) + '░'.repeat(w - filled);
    const bPct = this.totalBytes ? ((this.bytes / this.totalBytes) * 100).toFixed(1) : 0;
    const elapsed = (now - this.start) / 1000;
    const rate = elapsed > 0 ? this.bytes / elapsed : 0;
    const eta = rate > 0 && this.totalBytes ? ((this.totalBytes - this.bytes) / rate) : 0;
    const line = `\r${this.label} ${this.current}/${this.total} [${bar}] ${pct.toFixed(1)}%  ${formatBytes(this.bytes)}/${this.totalBytes ? formatBytes(this.totalBytes) : '?'} (${bPct}%)  ${formatBytes(rate)}/s  ETA: ${eta.toFixed(0)}s`;
    process.stderr.write(line.padEnd(120, ' '));
  }
  done() {
    this.render();
    process.stderr.write('\n');
  }
}

// ============== 增量传输 (简化版 rsync) ==============
function chunkFile(filePath, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return [];
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(chunkSize);
  let offset = 0;
  try {
    while (offset < stat.size) {
      const bytesRead = fs.readSync(fd, buf, 0, chunkSize, offset);
      const data = Buffer.from(buf.buffer, buf.byteOffset, bytesRead);
      chunks.push({ offset, size: bytesRead, hash: md5(data), data: Buffer.from(data) });
      offset += bytesRead;
    }
  } finally { fs.closeSync(fd); }
  return chunks;
}

function rollingChunks(filePath, chunkSize = CHUNK_SIZE) {
  const stat = fs.statSync(filePath);
  const hashes = [];
  if (stat.size === 0) return { hashes, size: 0 };
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(stat.size);
  try {
    fs.readSync(fd, buf, 0, stat.size, 0);
  } finally { fs.closeSync(fd); }

  const windowSize = Math.min(chunkSize, 4096);
  for (let i = 0; i < stat.size; i += windowSize) {
    const end = Math.min(i + windowSize, stat.size);
    hashes.push({ offset: i, size: end - i, hash: md5(buf.slice(i, end)) });
  }
  return { hashes, size: stat.size, data: buf };
}

function rsyncCopy(srcPath, dstPath, progress) {
  const srcStat = fs.statSync(srcPath);
  ensureDir(path.dirname(dstPath));

  if (!fs.existsSync(dstPath) || srcStat.size === 0) {
    fs.copyFileSync(srcPath, dstPath);
    const ctime = new Date(srcStat.mtime);
    fs.utimesSync(dstPath, ctime, ctime);
    if (progress) progress.addBytes(srcStat.size);
    return { totalSize: srcStat.size, transferred: srcStat.size, method: 'full' };
  }

  const tgtChunks = chunkFile(dstPath, CHUNK_SIZE);
  const tgtHashMap = new Map();
  tgtChunks.forEach((c, idx) => tgtHashMap.set(c.hash, idx));

  const srcChunks = chunkFile(srcPath, CHUNK_SIZE);
  const result = Buffer.alloc(srcStat.size);
  let transferred = 0;
  let reused = 0;

  for (const srcChunk of srcChunks) {
    if (tgtHashMap.has(srcChunk.hash)) {
      const tgtIdx = tgtHashMap.get(srcChunk.hash);
      const tgtChunk = tgtChunks[tgtIdx];
      if (tgtChunk.size === srcChunk.size) {
        const data = fs.readFileSync(dstPath).slice(tgtChunk.offset, tgtChunk.offset + tgtChunk.size);
        data.copy(result, srcChunk.offset);
        reused += srcChunk.size;
        continue;
      }
    }
    srcChunk.data.copy(result, srcChunk.offset);
    transferred += srcChunk.size;
  }

  fs.writeFileSync(dstPath, result);
  const ctime = new Date(srcStat.mtime);
  fs.utimesSync(dstPath, ctime, ctime);
  if (progress) progress.addBytes(transferred);

  return { totalSize: srcStat.size, transferred, reused, method: 'rsync' };
}

// ============== 日志系统 ==============
function getLogPath() {
  const now = new Date();
  const stamp = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0') + '_' +
    now.getHours().toString().padStart(2, '0') +
    now.getMinutes().toString().padStart(2, '0') +
    now.getSeconds().toString().padStart(2, '0');
  return path.join(LOG_DIR, `sync_${stamp}.json`);
}

function saveLog(log) {
  const p = getLogPath();
  fs.writeFileSync(p, JSON.stringify(log, null, 2));
  const idx = path.join(LOG_DIR, 'index.json');
  let logs = [];
  if (fs.existsSync(idx)) {
    try { logs = JSON.parse(fs.readFileSync(idx)); } catch { logs = []; }
  }
  logs.unshift({ file: path.basename(p), timestamp: log.timestamp, source: log.source, target: log.target, mode: log.mode, actions: log.actions.length });
  fs.writeFileSync(idx, JSON.stringify(logs, null, 2));
  return p;
}

function loadLogs() {
  const idx = path.join(LOG_DIR, 'index.json');
  if (!fs.existsSync(idx)) return [];
  try { return JSON.parse(fs.readFileSync(idx)); } catch { return []; }
}

function loadLatestLog() {
  const logs = loadLogs();
  if (!logs.length) return null;
  const p = path.join(LOG_DIR, logs[0].file);
  try { return JSON.parse(fs.readFileSync(p)); } catch { return null; }
}

function getBackupPath(relPath) {
  const safeName = relPath.replace(/[\\/:*?"<>|]/g, '_');
  const stamp = Date.now().toString() + '_' + Math.random().toString(36).slice(2, 6);
  return path.join(BACKUP_DIR, safeName + '.' + stamp + '.bak');
}

function backupFile(filePath, relPath) {
  if (!fs.existsSync(filePath)) return null;
  const backup = getBackupPath(relPath);
  fs.copyFileSync(filePath, backup);
  return backup;
}

// ============== 核心同步 ==============
function buildFilterOptions(cmdOpts) {
  return {
    maxSize: parseSize(cmdOpts['max-size']),
    newerThan: parseDateStr(cmdOpts['newer-than']),
    includes: cmdOpts.include ? (Array.isArray(cmdOpts.include) ? cmdOpts.include : [cmdOpts.include]) : null,
    excludes: cmdOpts.exclude ? (Array.isArray(cmdOpts.exclude) ? cmdOpts.exclude : [cmdOpts.exclude]) : null,
  };
}

function prepareSync(source, target, mode, cmdOpts) {
  const dryRun = !!cmdOpts['dry-run'];
  const filterOpts = buildFilterOptions(cmdOpts);

  let leftDir, rightDir, direction;
  if (mode === 'pull') {
    leftDir = target;
    rightDir = source;
    direction = 'pull';
  } else {
    leftDir = source;
    rightDir = target;
    direction = 'push';
  }

  const left = scanDir(leftDir, filterOpts);
  const right = scanDir(rightDir, filterOpts);

  const diff = detectDiff(left, right, direction);
  if (mode === 'mirror') {
    // mirror 删除目标独有文件
  } else if (mode === 'push' || mode === 'pull') {
    // push/pull 不删，清空 deleted 动作
    diff.deleted.length = 0;
  }

  return { source, target, mode, dryRun, diff, leftDir, rightDir, direction, filterOpts };
}

function printDiffSummary(diff) {
  const total = diff.added.length + diff.modified.length + diff.deleted.length;
  console.log('\n差异摘要:');
  console.log(`  新增文件:  ${diff.added.length} 个`);
  console.log(`  修改文件:  ${diff.modified.length} 个`);
  console.log(`  删除文件:  ${diff.deleted.length} 个`);
  console.log(`  未变文件:  ${diff.same.length} 个`);
  console.log(`  差异总计:  ${total} 个\n`);

  if (diff.added.length) {
    console.log('  [新增 +]');
    diff.added.forEach(f => console.log(`    ${f.relPath} (${formatBytes(f.size)})`));
  }
  if (diff.modified.length) {
    console.log('  [修改 ~]');
    diff.modified.forEach(f => {
      const s = f.source || f;
      console.log(`    ${f.relPath} (${formatBytes(s.size)})`);
    });
  }
  if (diff.deleted.length) {
    console.log('  [删除 -]');
    diff.deleted.forEach(f => console.log(`    ${f.relPath} (${formatBytes(f.size)})`));
  }
  return total;
}

function executeSync(ctx) {
  const { source, target, mode, dryRun, diff, leftDir, rightDir, direction } = ctx;
  const actions = [];
  let totalBytes = 0;

  diff.added.forEach(f => totalBytes += f.size);
  diff.modified.forEach(f => totalBytes += (f.source ? f.source.size : f.size));

  const totalOps = diff.added.length + diff.modified.length + diff.deleted.length;
  const progress = new ProgressBar(totalOps, dryRun ? '[DRY-RUN]' : '[同步]');
  progress.setTotalBytes(totalBytes);

  for (const f of diff.added) {
    const from = path.join(leftDir, f.relPath);
    const to = path.join(rightDir, f.relPath);
    const info = { type: 'add', relPath: f.relPath, from, to, size: f.size, backup: null };
    if (!dryRun) {
      const result = rsyncCopy(from, to, progress);
      if (result.method === 'rsync' && result.reused > 0) {
        totalBytes -= result.reused;
        progress.setTotalBytes(totalBytes);
      }
    } else {
      progress.addBytes(f.size);
    }
    actions.push(info);
    progress.inc();
  }

  for (const f of diff.modified) {
    const s = f.source || f;
    const from = path.join(leftDir, f.relPath);
    const to = path.join(rightDir, f.relPath);
    const info = { type: 'modify', relPath: f.relPath, from, to, size: s.size, backup: null };
    if (!dryRun) {
      info.backup = backupFile(to, f.relPath);
      const result = rsyncCopy(from, to, progress);
      if (result.method === 'rsync' && result.reused > 0) {
        totalBytes -= result.reused;
        progress.setTotalBytes(totalBytes);
      }
    } else {
      progress.addBytes(s.size);
    }
    actions.push(info);
    progress.inc();
  }

  for (const f of diff.deleted) {
    const delPath = path.join(rightDir, f.relPath);
    const info = { type: 'delete', relPath: f.relPath, path: delPath, size: f.size, backup: null };
    if (!dryRun) {
      info.backup = backupFile(delPath, f.relPath);
      if (fs.existsSync(delPath)) fs.unlinkSync(delPath);
    }
    actions.push(info);
    progress.inc();
  }

  progress.done();

  if (!dryRun) {
    const log = {
      timestamp: new Date().toISOString(),
      source, target, mode, direction,
      actions,
      summary: { added: diff.added.length, modified: diff.modified.length, deleted: diff.deleted.length }
    };
    const logPath = saveLog(log);
    console.log(`\n日志已保存: ${logPath}`);
  }

  return actions;
}

// ============== 命令处理 ==============
function cmdDiff(args) {
  const source = args._[0];
  const target = args._[1];
  if (!source || !target) {
    console.error('用法: node filesync.js diff SOURCE TARGET [options]');
    process.exit(1);
  }
  const filterOpts = buildFilterOptions(args.options);
  const s = scanDir(source, filterOpts);
  const t = scanDir(target, filterOpts);
  const diff = detectDiff(s, t, 'push');
  console.log(`\n比较: ${source}  →  ${target}`);
  printDiffSummary(diff);
}

function cmdSync(args) {
  let { options, _: positional } = args;
  let source = positional[0];
  let target = positional[1];
  const mode = options.mode || 'mirror';

  if (!MODES.includes(mode)) {
    console.error(`错误: 模式必须是 ${MODES.join(', ')}`);
    process.exit(1);
  }

  if (options.profile) {
    const profiles = loadProfiles();
    const p = profiles[options.profile];
    if (!p) { console.error(`配置 "${options.profile}" 不存在`); process.exit(1); }
    source = source || p.source;
    target = target || p.target;
    if (!options.mode) options.mode = p.mode || 'mirror';
    if (p.include && !options.include) options.include = p.include;
    if (p.exclude && !options.exclude) options.exclude = p.exclude;
    if (p['max-size'] && !options['max-size']) options['max-size'] = p['max-size'];
    if (p['newer-than'] && !options['newer-than']) options['newer-than'] = p['newer-than'];
    if (p.reminder) {
      console.log(`⏰ 提醒: ${p.reminder}`);
    }
  }

  if (!source || !target) {
    console.error('用法: node filesync.js sync SOURCE TARGET [options]');
    console.error('  或:  node filesync.js sync --profile NAME');
    console.error('  选项: --mode mirror|push|pull  --dry-run  --include  --exclude  --max-size  --newer-than');
    process.exit(1);
  }

  const ctx = prepareSync(source, target, mode, options);
  console.log(`\n同步: ${source}  →  ${target}`);
  console.log(`模式: ${mode}${options['dry-run'] ? ' (DRY-RUN)' : ''}`);
  const changes = printDiffSummary(ctx.diff);
  if (changes === 0) {
    console.log('没有需要同步的变化。');
    return;
  }
  executeSync(ctx);
}

function cmdLog(args) {
  const n = parseInt(args.options.n || args.options.last || '10');
  const logs = loadLogs().slice(0, n);
  if (!logs.length) { console.log('暂无同步日志。'); return; }
  console.log(`\n历史同步记录 (最近 ${logs.length} 条):\n`);
  logs.forEach((l, i) => {
    console.log(`  ${(i + 1).toString().padStart(2, ' ')}. [${formatDate(l.timestamp)}] ${l.mode.padEnd(7)} ${l.source} → ${l.target}  (${l.actions} 个操作)`);
  });
  console.log();

  if (args.options.detail || args.options.d) {
    const latest = loadLatestLog();
    if (latest) {
      console.log('最近一次同步详情:');
      latest.actions.forEach(a => {
        const icon = a.type === 'add' ? '+' : a.type === 'modify' ? '~' : '-';
        console.log(`  [${icon}] ${a.relPath} (${formatBytes(a.size || 0)})${a.backup ? ' [backup: ' + path.basename(a.backup) + ']' : ''}`);
      });
      console.log();
    }
  }
}

function cmdUndo(args) {
  const log = loadLatestLog();
  if (!log) { console.log('没有可回滚的同步记录。'); return; }
  const dryRun = !!args.options['dry-run'];
  console.log(`\n回滚: ${formatDate(log.timestamp)}  ${log.mode}  ${log.source} → ${log.target}`);
  console.log(`${log.actions.length} 个操作待回滚${dryRun ? ' (DRY-RUN)' : ''}\n`);

  let restored = 0, removed = 0, skipped = 0;
  for (const a of [...log.actions].reverse()) {
    if (a.type === 'add') {
      const p = a.to;
      if (dryRun) console.log(`  [删除新增] ${a.relPath}`);
      else if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`  [-] 删除: ${a.relPath}`); removed++; }
      else { console.log(`  [跳过] 不存在: ${a.relPath}`); skipped++; }
    } else if (a.type === 'modify' || a.type === 'delete') {
      if (!a.backup || !fs.existsSync(a.backup)) {
        console.log(`  [跳过] 无备份: ${a.relPath}`); skipped++; continue;
      }
      const target = a.type === 'modify' ? a.to : a.path;
      if (dryRun) console.log(`  [恢复备份] ${a.relPath} ← ${path.basename(a.backup)}`);
      else {
        ensureDir(path.dirname(target));
        fs.copyFileSync(a.backup, target);
        console.log(`  [~] 恢复: ${a.relPath}`);
        restored++;
      }
    }
  }
  if (!dryRun) console.log(`\n完成: 恢复 ${restored} 个, 删除 ${removed} 个, 跳过 ${skipped} 个\n`);
}

// ============== Profile 管理 ==============
function loadProfiles() {
  if (!fs.existsSync(PROFILE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PROFILE_FILE)); } catch { return {}; }
}

function saveProfiles(p) {
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(p, null, 2));
}

function cmdProfile(args) {
  const sub = args._[0];
  const profiles = loadProfiles();

  if (!sub || sub === 'list' || sub === 'ls') {
    const names = Object.keys(profiles);
    if (!names.length) { console.log('暂无配置。使用: profile add NAME [options]'); return; }
    console.log('\n同步配置列表:\n');
    names.forEach(n => {
      const p = profiles[n];
      console.log(`  ${n}`);
      console.log(`    源:   ${p.source}`);
      console.log(`    目标: ${p.target}`);
      console.log(`    模式: ${p.mode || 'mirror'}`);
      if (p.include) console.log(`    包含: ${p.include}`);
      if (p.exclude) console.log(`    排除: ${p.exclude}`);
      if (p['max-size']) console.log(`    大小: ${p['max-size']}`);
      if (p['newer-than']) console.log(`    时间: ${p['newer-than']}`);
      if (p.reminder) console.log(`    提醒: ${p.reminder}`);
      console.log();
    });
    return;
  }

  if (sub === 'add' || sub === 'create') {
    const name = args._[1];
    if (!name) { console.error('用法: profile add NAME --source PATH --target PATH [--mode mirror|push|pull] [--reminder TEXT]'); process.exit(1); }
    const opts = args.options;
    if (!opts.source || !opts.target) { console.error('必须指定 --source 和 --target'); process.exit(1); }
    profiles[name] = {
      source: opts.source,
      target: opts.target,
      mode: opts.mode || 'mirror',
      include: opts.include,
      exclude: opts.exclude,
      'max-size': opts['max-size'],
      'newer-than': opts['newer-than'],
      reminder: opts.reminder,
    };
    saveProfiles(profiles);
    console.log(`配置 "${name}" 已保存。`);
    return;
  }

  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const name = args._[1];
    if (!profiles[name]) { console.error(`配置 "${name}" 不存在`); process.exit(1); }
    delete profiles[name];
    saveProfiles(profiles);
    console.log(`配置 "${name}" 已删除。`);
    return;
  }

  if (sub === 'run') {
    const name = args._[1];
    if (!profiles[name]) { console.error(`配置 "${name}" 不存在`); process.exit(1); }
    cmdSync({ options: { ...args.options, profile: name }, _: [] });
    return;
  }

  console.error('用法: profile [list|add NAME|rm NAME|run NAME]');
}

// ============== 主入口 ==============
function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.log(`
文件同步工具 - filesync.js

用法:
  node filesync.js <command> [args] [options]

命令:
  sync SOURCE TARGET   同步目录 (模式: mirror|push|pull)
  diff SOURCE TARGET   仅显示差异不同步
  log                  查看同步历史日志
  undo                 回滚上次同步
  profile              管理同步配置

选项:
  --mode mirror        mirror(完全镜像) / push(只增不删) / pull(反向)
  --dry-run            仅显示要执行的操作
  --include PATTERN    glob 包含模式 (可多次)
  --exclude PATTERN    glob 排除模式 (可多次)
  --max-size SIZE      最大文件大小 (如 10M)
  --newer-than DATE    仅同步修改晚于该日期的文件
  --profile NAME       使用已保存的配置执行

示例:
  node filesync.js diff source target
  node filesync.js sync source target --mode push --dry-run
  node filesync.js sync source target --mode mirror --exclude "*.log"
  node filesync.js sync source target --max-size 10M --newer-than "2024-01-01"
  node filesync.js profile add mybackup --source ./source --target ./target --mode mirror --reminder "每天记得备份！"
  node filesync.js sync --profile mybackup
  node filesync.js log --detail
  node filesync.js undo
`);
    process.exit(0);
  }

  const cmd = argv[0];
  const rest = argv.slice(1);
  const parsed = parseArgs(rest);

  switch (cmd) {
    case 'sync': cmdSync(parsed); break;
    case 'diff': cmdDiff(parsed); break;
    case 'log': case 'logs': cmdLog(parsed); break;
    case 'undo': case 'rollback': cmdUndo(parsed); break;
    case 'profile': case 'profiles': cmdProfile(parsed); break;
    default:
      console.error(`未知命令: ${cmd}`);
      process.exit(1);
  }
}

main();
