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
const STATE_FILE = path.join(APP_DIR, 'state.json');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const REMOTES_FILE = path.join(APP_DIR, 'remotes.json');
const REMOTE_MIRRORS_DIR = path.join(APP_DIR, 'remote_mirrors');
const CHUNK_SIZE = 4 * 1024; // 4KB 块（小文件也能触发增量复用）
const MODES = ['mirror', 'push', 'pull', 'bidirectional'];
const ENC_SUFFIX = '.enc';
const CONFLICT_SUFFIX = '.conflict';
const ALGORITHM = 'aes-256-cbc';

ensureDir(REMOTE_MIRRORS_DIR);

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

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sleep(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {}
}

// ============== 加解密工具 ==============
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}

function encryptBuffer(buffer, password) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([salt, iv, encrypted]);
}

function decryptBuffer(buffer, password) {
  const salt = buffer.slice(0, 16);
  const iv = buffer.slice(16, 32);
  const encrypted = buffer.slice(32);
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function encryptFile(srcPath, dstPath, password, progress) {
  const stat = fs.statSync(srcPath);
  ensureDir(path.dirname(dstPath));
  const data = fs.readFileSync(srcPath);
  const encrypted = encryptBuffer(data, password);
  fs.writeFileSync(dstPath, encrypted);
  const ctime = new Date(stat.mtime);
  fs.utimesSync(dstPath, ctime, ctime);
  if (progress) progress.addBytes(stat.size);
  return { totalSize: stat.size, transferred: stat.size, method: 'encrypt' };
}

function decryptFile(srcPath, dstPath, password, progress) {
  const stat = fs.statSync(srcPath);
  ensureDir(path.dirname(dstPath));
  const encrypted = fs.readFileSync(srcPath);
  const data = decryptBuffer(encrypted, password);
  fs.writeFileSync(dstPath, data);
  if (progress) progress.addBytes(stat.size);
  return { totalSize: stat.size, transferred: stat.size, method: 'decrypt' };
}

// ============== 配置管理 ==============
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE)); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function setPassword() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('请输入密码: ', (pwd) => {
      rl.question('请再次输入密码: ', (pwd2) => {
        rl.close();
        if (pwd !== pwd2) {
          console.error('两次输入的密码不一致！');
          resolve(false);
          return;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = sha256(pwd + salt);
        const cfg = loadConfig();
        cfg.password = { hash, salt };
        saveConfig(cfg);
        console.log('密码已设置成功。');
        resolve(true);
      });
    });
  });
}

function getPassword() {
  const cfg = loadConfig();
  if (!cfg.password) {
    console.error('未设置密码，请先使用 --set-password 设置密码。');
    process.exit(1);
  }
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('请输入密码: ', (pwd) => {
      rl.close();
      const hash = sha256(pwd + cfg.password.salt);
      if (hash !== cfg.password.hash) {
        console.error('密码错误！');
        process.exit(1);
      }
      resolve(pwd);
    });
  });
}

// ============== 同步状态管理 ==============
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { files: {}, conflicts: [] };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE));
    if (!s.files) s.files = {};
    if (!s.conflicts) s.conflicts = [];
    return s;
  } catch {
    return { files: {}, conflicts: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getSyncKey(source, target) {
  return `${source}::${target}`;
}

function getLastSyncTime(source, target, relPath) {
  const state = loadState();
  const key = getSyncKey(source, target);
  return state.files[key]?.[relPath] || 0;
}

function updateSyncTime(source, target, relPath, timestamp) {
  const state = loadState();
  const key = getSyncKey(source, target);
  if (!state.files[key]) state.files[key] = {};
  state.files[key][relPath] = timestamp;
  saveState(state);
}

function addConflict(source, target, relPath, sourceFile, targetFile) {
  const state = loadState();
  const key = getSyncKey(source, target);
  const existing = state.conflicts.find(c => c.key === key && c.relPath === relPath && !c.resolved);
  if (!existing) {
    state.conflicts.push({
      key,
      relPath,
      sourceFile,
      targetFile,
      sourceMtime: fs.statSync(sourceFile).mtime.getTime(),
      targetMtime: fs.statSync(targetFile).mtime.getTime(),
      resolved: false,
      timestamp: Date.now()
    });
    saveState(state);
  }
}

function removeConflict(source, target, relPath) {
  const state = loadState();
  const key = getSyncKey(source, target);
  state.conflicts = state.conflicts.filter(c => !(c.key === key && c.relPath === relPath && !c.resolved));
  saveState(state);
}

function getUnresolvedConflicts(source, target) {
  const state = loadState();
  const key = getSyncKey(source, target);
  return state.conflicts.filter(c => c.key === key && !c.resolved);
}

function markConflictResolved(source, target, relPath, choice) {
  const state = loadState();
  const key = getSyncKey(source, target);
  const conflict = state.conflicts.find(c => c.key === key && c.relPath === relPath && !c.resolved);
  if (conflict) {
    conflict.resolved = true;
    conflict.resolution = choice;
    conflict.resolvedAt = Date.now();
    saveState(state);
  }
}

// ============== 远程目录管理 ==============
function loadRemotes() {
  if (!fs.existsSync(REMOTES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(REMOTES_FILE)); } catch { return {}; }
}

function saveRemotes(remotes) {
  fs.writeFileSync(REMOTES_FILE, JSON.stringify(remotes, null, 2));
}

function isRemotePath(p) {
  return typeof p === 'string' && p.startsWith('remote://');
}

function resolveRemotePath(p) {
  if (!isRemotePath(p)) return p;
  const name = p.slice('remote://'.length);
  const remotes = loadRemotes();
  if (!remotes[name]) {
    console.error(`远程配置 "${name}" 不存在，请先添加: remote add ${name} user@host:/path`);
    process.exit(1);
  }
  const mirrorPath = path.join(REMOTE_MIRRORS_DIR, name);
  ensureDir(mirrorPath);
  return mirrorPath;
}

function simulateNetworkDelay() {
  sleep(50);
}

function getRemoteName(p) {
  if (!isRemotePath(p)) return null;
  return p.slice('remote://'.length);
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

// ============== 双向同步差异检测 ==============
function detectBidirectionalDiff(source, target, sourceFiles, targetFiles, lastSyncTimes) {
  const toSource = [];
  const toTarget = [];
  const conflicts = [];
  const same = [];

  const allKeys = new Set([...Object.keys(sourceFiles), ...Object.keys(targetFiles)]);

  for (const key of allKeys) {
    const s = sourceFiles[key];
    const t = targetFiles[key];
    const lastSync = lastSyncTimes[key] || 0;

    if (s && !t) {
      const sourceModified = s.mtime > lastSync;
      if (sourceModified) {
        toTarget.push({ relPath: key, from: 'source', ...s });
      } else {
        toSource.push({ relPath: key, from: 'target-deleted', ...s, action: 'delete-from-source' });
      }
    } else if (!s && t) {
      const targetModified = t.mtime > lastSync;
      if (targetModified) {
        toSource.push({ relPath: key, from: 'target', ...t });
      } else {
        toTarget.push({ relPath: key, from: 'source-deleted', ...t, action: 'delete-from-target' });
      }
    } else {
      const sourceModified = s.mtime > lastSync;
      const targetModified = t.mtime > lastSync;

      if (sourceModified && targetModified) {
        if (s.mtime !== t.mtime || s.size !== t.size) {
          conflicts.push({ relPath: key, source: s, target: t });
        } else {
          same.push({ relPath: key, ...s });
        }
      } else if (sourceModified) {
        toTarget.push({ relPath: key, from: 'source', source: s, target: t });
      } else if (targetModified) {
        toSource.push({ relPath: key, from: 'target', source: t, target: s });
      } else {
        same.push({ relPath: key, ...s });
      }
    }
  }

  return { toSource, toTarget, conflicts, same };
}

// ============== 进度条 ==============
class ProgressBar {
  constructor(total, label = '', prefix = '') {
    this.total = total;
    this.current = 0;
    this.label = label;
    this.prefix = prefix;
    this.bytes = 0;
    this.totalBytes = 0;
    this.start = Date.now();
    this.lastRender = 0;
    this.simulatedRate = null;
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
  setSimulatedRate(rate) { this.simulatedRate = rate; }
  render() {
    const now = Date.now();
    if (now - this.lastRender < 50 && this.current < this.total) return;
    this.lastRender = now;
    const pct = this.total ? (this.current / this.total) * 100 : 0;
    const w = 30;
    const filled = Math.round((pct / 100) * w);
    const bar = '█'.repeat(filled) + '░'.repeat(w - filled);
    const denom = Math.max(this.totalBytes, this.bytes);
    const bPct = denom > 0 ? ((this.bytes / denom) * 100).toFixed(1) : 0;
    const dispTotal = denom > 0 ? formatBytes(denom) : '?';
    const elapsed = (now - this.start) / 1000;
    const rate = this.simulatedRate || (elapsed > 0 ? this.bytes / elapsed : 0);
    const eta = rate > 0 && this.totalBytes > this.bytes ? ((this.totalBytes - this.bytes) / rate) : 0;
    const prefixStr = this.prefix ? `[${this.prefix}] ` : '';
    const line = `\r${prefixStr}${this.label} ${this.current}/${this.total} [${bar}] ${pct.toFixed(1)}%  ${formatBytes(this.bytes)}/${dispTotal} (${bPct}%)  ${formatBytes(rate)}/s  ETA: ${eta.toFixed(0)}s`;
    process.stderr.write(line.padEnd(140, ' '));
  }
  done() {
    this.totalBytes = this.bytes;
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

function adjustPathForEncrypt(p, encrypt) {
  if (!encrypt) return p;
  if (p.endsWith(ENC_SUFFIX)) return p;
  return p + ENC_SUFFIX;
}

function adjustPathForDecrypt(p) {
  if (p.endsWith(ENC_SUFFIX)) return p.slice(0, -ENC_SUFFIX.length);
  return p;
}

function prepareSync(source, target, mode, cmdOpts) {
  const dryRun = !!cmdOpts['dry-run'];
  const encrypt = !!cmdOpts.encrypt;
  const filterOpts = buildFilterOptions(cmdOpts);

  const isSourceRemote = isRemotePath(source);
  const isTargetRemote = isRemotePath(target);
  const sourceDir = resolveRemotePath(source);
  const targetDir = resolveRemotePath(target);

  if (mode === 'bidirectional') {
    const sourceFiles = scanDir(sourceDir, filterOpts);
    const targetScanOpts = { ...filterOpts };
    if (encrypt) {
      targetScanOpts.includes = ['*' + ENC_SUFFIX];
    }
    const targetFilesRaw = scanDir(targetDir, targetScanOpts);
    const targetFiles = {};
    for (const [key, val] of Object.entries(targetFilesRaw)) {
      const adjustedKey = encrypt ? adjustPathForDecrypt(key) : key;
      targetFiles[adjustedKey] = { ...val, relPath: adjustedKey, path: val.path };
    }

    const state = loadState();
    const syncKey = getSyncKey(source, target);
    const lastSyncTimes = state.files[syncKey] || {};

    const diff = detectBidirectionalDiff(source, target, sourceFiles, targetFiles, lastSyncTimes);

    return {
      source, target, mode, dryRun, encrypt,
      sourceDir, targetDir,
      isSourceRemote, isTargetRemote,
      diff, filterOpts,
      isBidirectional: true
    };
  }

  let leftDir, rightDir, direction, leftOrig, rightOrig;
  if (mode === 'pull') {
    leftDir = targetDir;
    rightDir = sourceDir;
    leftOrig = target;
    rightOrig = source;
    direction = 'pull';
  } else {
    leftDir = sourceDir;
    rightDir = targetDir;
    leftOrig = source;
    rightOrig = target;
    direction = 'push';
  }

  const left = scanDir(leftDir, filterOpts);
  let right = scanDir(rightDir, filterOpts);

  if (encrypt && direction === 'push') {
    const adjustedRight = {};
    for (const [key, val] of Object.entries(right)) {
      const adjustedKey = key.endsWith(ENC_SUFFIX) ? key.slice(0, -ENC_SUFFIX.length) : key;
      adjustedRight[adjustedKey] = { ...val, relPath: adjustedKey };
    }
    right = adjustedRight;
  }

  const diff = detectDiff(left, right, direction);
  if (mode === 'mirror') {
    // mirror 删除目标独有文件
  } else if (mode === 'push' || mode === 'pull') {
    // push/pull 不删，清空 deleted 动作
    diff.deleted.length = 0;
  }

  return {
    source, target, mode, dryRun, encrypt,
    sourceDir, targetDir,
    isSourceRemote, isTargetRemote,
    leftDir, rightDir, leftOrig, rightOrig,
    direction, diff, filterOpts,
    isBidirectional: false
  };
}

function printDiffSummary(diff, isBidirectional = false) {
  if (isBidirectional) {
    const total = diff.toSource.length + diff.toTarget.length + diff.conflicts.length;
    console.log('\n双向同步差异摘要:');
    console.log(`  同步到源:  ${diff.toSource.length} 个`);
    console.log(`  同步到目标: ${diff.toTarget.length} 个`);
    console.log(`  冲突文件:  ${diff.conflicts.length} 个`);
    console.log(`  未变文件:  ${diff.same.length} 个`);
    console.log(`  差异总计:  ${total} 个\n`);

    if (diff.toTarget.length) {
      console.log('  [→ 目标]');
      diff.toTarget.forEach(f => console.log(`    ${f.relPath} (${formatBytes(f.size || (f.source && f.source.size) || 0)})`));
    }
    if (diff.toSource.length) {
      console.log('  [→ 源]');
      diff.toSource.forEach(f => {
        if (f.action === 'delete-from-source') {
          console.log(`    ${f.relPath} [删除]`);
        } else if (f.action === 'delete-from-target') {
          console.log(`    ${f.relPath} [删除]`);
        } else {
          console.log(`    ${f.relPath} (${formatBytes(f.size || (f.source && f.source.size) || 0)})`);
        }
      });
    }
    if (diff.conflicts.length) {
      console.log('  [冲突 !]');
      diff.conflicts.forEach(f => {
        const sTime = formatDate(new Date(f.source.mtime));
        const tTime = formatDate(new Date(f.target.mtime));
        console.log(`    ${f.relPath}  源: ${sTime} (${formatBytes(f.source.size)})  目标: ${tTime} (${formatBytes(f.target.size)})`);
      });
    }
    return total;
  }

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

function estimateTransferredBytes(srcPath, dstPath) {
  if (!fs.existsSync(dstPath)) {
    return fs.existsSync(srcPath) ? fs.statSync(srcPath).size : 0;
  }
  const srcStat = fs.statSync(srcPath);
  if (srcStat.size === 0) return 0;
  const tgtChunks = chunkFile(dstPath, CHUNK_SIZE);
  const tgtHashMap = new Map();
  tgtChunks.forEach((c, idx) => tgtHashMap.set(c.hash, idx));
  const srcChunks = chunkFile(srcPath, CHUNK_SIZE);
  let transferred = 0;
  for (const srcChunk of srcChunks) {
    if (tgtHashMap.has(srcChunk.hash)) {
      const tgtIdx = tgtHashMap.get(srcChunk.hash);
      const tgtChunk = tgtChunks[tgtIdx];
      if (tgtChunk.size === srcChunk.size) continue;
    }
    transferred += srcChunk.size;
  }
  return transferred;
}

function getProgressPrefix(ctx) {
  if (ctx.encrypt) return '加密传输';
  if (ctx.isSourceRemote || ctx.isTargetRemote) return '远程传输';
  return '';
}

async function executeSync(ctx, password = null) {
  if (ctx.isBidirectional) {
    return executeBidirectionalSync(ctx, password);
  }

  const { source, target, mode, dryRun, diff, leftDir, rightDir, direction, encrypt, isSourceRemote, isTargetRemote } = ctx;
  const actions = [];
  let totalBytes = 0;

  diff.added.forEach(f => totalBytes += f.size);
  if (dryRun) {
    diff.modified.forEach(f => totalBytes += (f.source ? f.source.size : f.size));
  } else {
    diff.modified.forEach(f => {
      const s = f.source || f;
      const from = path.join(leftDir, f.relPath);
      const to = path.join(rightDir, f.relPath);
      totalBytes += estimateTransferredBytes(from, to);
    });
  }

  const totalOps = diff.added.length + diff.modified.length + diff.deleted.length;
  const prefix = getProgressPrefix(ctx);
  const progress = new ProgressBar(totalOps, dryRun ? '[DRY-RUN]' : '[同步]', prefix);
  progress.setTotalBytes(totalBytes);
  if (isSourceRemote || isTargetRemote) {
    progress.setSimulatedRate(1024 * 1024);
  }

  const transferFile = (from, to, size, isAdd = false) => {
    if (isSourceRemote || isTargetRemote) simulateNetworkDelay();
    if (encrypt && direction === 'push') {
      const encTo = adjustPathForEncrypt(to, true);
      encryptFile(from, encTo, password, progress);
    } else if (encrypt && direction === 'pull') {
      decryptFile(from, to, password, progress);
    } else {
      rsyncCopy(from, to, progress);
    }
  };

  for (const f of diff.added) {
    const from = path.join(leftDir, f.relPath);
    let to = path.join(rightDir, f.relPath);
    const info = { type: 'add', relPath: f.relPath, from, to, size: f.size, backup: null };
    if (!dryRun) {
      transferFile(from, to, f.size, true);
    } else {
      progress.addBytes(f.size);
    }
    actions.push(info);
    progress.inc();
  }

  for (const f of diff.modified) {
    const s = f.source || f;
    const from = path.join(leftDir, f.relPath);
    let to = path.join(rightDir, f.relPath);
    const info = { type: 'modify', relPath: f.relPath, from, to, size: s.size, backup: null };
    if (!dryRun) {
      info.backup = backupFile(to, f.relPath);
      transferFile(from, to, s.size);
    } else {
      progress.addBytes(s.size);
    }
    actions.push(info);
    progress.inc();
  }

  for (const f of diff.deleted) {
    let delPath = path.join(rightDir, f.relPath);
    if (encrypt && direction === 'push') {
      delPath = adjustPathForEncrypt(delPath, true);
    }
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

async function executeBidirectionalSync(ctx, password = null) {
  const { source, target, dryRun, diff, sourceDir, targetDir, encrypt, isSourceRemote, isTargetRemote } = ctx;
  const actions = [];
  const conflicts = [];
  let totalBytes = 0;

  diff.toTarget.forEach(f => totalBytes += (f.size || (f.source && f.source.size) || 0));
  diff.toSource.forEach(f => {
    if (!f.action) totalBytes += (f.size || (f.source && f.source.size) || 0);
  });

  const totalOps = diff.toTarget.length + diff.toSource.length + diff.conflicts.length;
  const prefix = getProgressPrefix(ctx);
  const progress = new ProgressBar(totalOps, dryRun ? '[DRY-RUN]' : '[双向同步]', prefix);
  progress.setTotalBytes(totalBytes);
  if (isSourceRemote || isTargetRemote) {
    progress.setSimulatedRate(1024 * 1024);
  }

  const now = Date.now();

  const transferToTarget = (f) => {
    const from = path.join(sourceDir, f.relPath);
    let to = path.join(targetDir, f.relPath);
    if (encrypt) to = adjustPathForEncrypt(to, true);
    const info = { type: 'sync-to-target', relPath: f.relPath, from, to, size: f.size || (f.source && f.source.size) || 0 };
    if (!dryRun) {
      if (isSourceRemote || isTargetRemote) simulateNetworkDelay();
      if (encrypt) {
        encryptFile(from, to, password, progress);
      } else {
        rsyncCopy(from, to, progress);
      }
      updateSyncTime(source, target, f.relPath, now);
    } else {
      progress.addBytes(info.size);
    }
    actions.push(info);
    progress.inc();
  };

  const transferToSource = (f) => {
    let from = path.join(targetDir, f.relPath);
    const to = path.join(sourceDir, f.relPath);
    if (encrypt) from = adjustPathForEncrypt(from, true);
    const info = { type: 'sync-to-source', relPath: f.relPath, from, to, size: f.size || (f.source && f.source.size) || 0 };
    if (!dryRun) {
      if (isSourceRemote || isTargetRemote) simulateNetworkDelay();
      if (encrypt) {
        decryptFile(from, to, password, progress);
      } else {
        rsyncCopy(from, to, progress);
      }
      updateSyncTime(source, target, f.relPath, now);
    } else {
      progress.addBytes(info.size);
    }
    actions.push(info);
    progress.inc();
  };

  for (const f of diff.toTarget) {
    if (f.action === 'delete-from-target') {
      let delPath = path.join(targetDir, f.relPath);
      if (encrypt) delPath = adjustPathForEncrypt(delPath, true);
      const info = { type: 'delete-from-target', relPath: f.relPath, path: delPath };
      if (!dryRun) {
        if (fs.existsSync(delPath)) fs.unlinkSync(delPath);
        updateSyncTime(source, target, f.relPath, now);
      }
      actions.push(info);
      progress.inc();
    } else {
      transferToTarget(f);
    }
  }

  for (const f of diff.toSource) {
    if (f.action === 'delete-from-source') {
      const delPath = path.join(sourceDir, f.relPath);
      const info = { type: 'delete-from-source', relPath: f.relPath, path: delPath };
      if (!dryRun) {
        if (fs.existsSync(delPath)) fs.unlinkSync(delPath);
        updateSyncTime(source, target, f.relPath, now);
      }
      actions.push(info);
      progress.inc();
    } else {
      transferToSource(f);
    }
  }

  for (const f of diff.conflicts) {
    const sourceFile = path.join(sourceDir, f.relPath);
    let targetFile = path.join(targetDir, f.relPath);
    if (encrypt) targetFile = adjustPathForEncrypt(targetFile, true);
    const conflictFile = path.join(targetDir, f.relPath + CONFLICT_SUFFIX);
    const info = { type: 'conflict', relPath: f.relPath, sourceFile, targetFile, conflictFile };

    if (!dryRun) {
      if (fs.existsSync(targetFile)) {
        fs.copyFileSync(targetFile, conflictFile);
      }
      addConflict(source, target, f.relPath, sourceFile, targetFile);
    }
    conflicts.push(info);
    progress.inc();
  }

  progress.done();

  if (conflicts.length > 0) {
    console.log(`\n发现 ${conflicts.length} 个冲突文件：`);
    conflicts.forEach(c => {
      console.log(`  ! ${c.relPath} -> ${path.basename(c.conflictFile)}`);
    });
    console.log('\n请使用 resolve 命令处理冲突: node filesync.js resolve ${source} ${target}');
    console.log('  选项: source (保留源版本) | target (保留目标版本) | both (保留两个版本)');
  }

  if (!dryRun) {
    const log = {
      timestamp: new Date().toISOString(),
      source, target, mode: 'bidirectional',
      actions,
      conflicts: conflicts.map(c => ({ relPath: c.relPath })),
      summary: {
        toTarget: diff.toTarget.length, toSource: diff.toSource.length, conflicts: diff.conflicts.length }
    };
    const logPath = saveLog(log);
    console.log(`\n日志已保存: ${logPath}`);
  }

  return { actions, conflicts };
}

// ============== 命令处理 ==============
function cmdDiff(args) {
  let source = args._[0];
  let target = args._[1];
  if (!source || !target) {
    console.error('用法: node filesync.js diff SOURCE TARGET [options]');
    process.exit(1);
  }
  const filterOpts = buildFilterOptions(args.options);

  source = resolveRemotePath(source);
  target = resolveRemotePath(target);

  let s = scanDir(source, filterOpts);
  let t = scanDir(target, filterOpts);

  const encFiles = [];
  const filteredT = {};
  for (const [key, val] of Object.entries(t)) {
    if (key.endsWith(ENC_SUFFIX)) {
      encFiles.push(key);
      const origKey = key.slice(0, -ENC_SUFFIX.length);
      filteredT[origKey] = { ...val, relPath: origKey, encrypted: true };
    } else {
      filteredT[key] = val;
    }
  }
  t = filteredT;

  const onlyInSource = [];
  const onlyInTarget = [];
  const different = [];
  const same = [];
  const encryptedSkip = [];

  const allKeys = new Set([...Object.keys(s), ...Object.keys(t)]);

  for (const key of allKeys) {
    const src = s[key];
    const tgt = t[key];

    if (src && !tgt) {
      onlyInSource.push({ relPath: key, ...src });
    } else if (!src && tgt) {
      onlyInTarget.push({ relPath: key, ...tgt });
    } else {
      if (tgt.encrypted) {
        encryptedSkip.push({ relPath: key, size: src.size, encryptedSize: tgt.size });
      } else if (src.mtime !== tgt.mtime || src.size !== tgt.size) {
        different.push({ relPath: key, source: src, target: tgt });
      } else {
        same.push({ relPath: key, ...src });
      }
    }
  }

  console.log(`\n比较: ${source}  →  ${target}`);
  console.log('\n差异摘要:');
  console.log(`  仅在源:   ${onlyInSource.length} 个`);
  console.log(`  仅在目标: ${onlyInTarget.length} 个`);
  console.log(`  内容不同: ${different.length} 个`);
  console.log(`  加密跳过: ${encryptedSkip.length} 个`);
  console.log(`  内容相同: ${same.length} 个\n`);

  if (onlyInSource.length) {
    console.log('  [仅在源 +]');
    onlyInSource.forEach(f => console.log(`    ${f.relPath} (${formatBytes(f.size)})`));
  }
  if (onlyInTarget.length) {
    console.log('  [仅在目标 -]');
    onlyInTarget.forEach(f => console.log(`    ${f.relPath} (${formatBytes(f.size)})`));
  }
  if (different.length) {
    console.log('  [不同 ~]');
    different.forEach(f => console.log(`    ${f.relPath}  源: ${formatBytes(f.source.size)} / 目标: ${formatBytes(f.target.size)}`));
  }
  if (encryptedSkip.length) {
    console.log('  [加密跳过]');
    encryptedSkip.forEach(f => console.log(`    ${f.relPath}  (已加密，跳过内容对比)`));
  }
}

async function cmdSync(args) {
  let { options, _: positional } = args;
  let source = positional[0];
  let target = positional[1];
  const mode = options.mode || 'mirror';

  if (options['set-password']) {
    await setPassword();
    return;
  }

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
    console.error('  选项: --mode mirror|push|pull|bidirectional  --dry-run  --include  --exclude  --max-size  --newer-than  --encrypt');
    process.exit(1);
  }

  const ctx = prepareSync(source, target, mode, options);
  console.log(`\n同步: ${source}  →  ${target}`);
  console.log(`模式: ${mode}${options['dry-run'] ? ' (DRY-RUN)' : ''}`);
  if (options.encrypt) console.log('加密: 已启用 (AES-256)');

  let password = null;
  if (options.encrypt) {
    password = await getPassword();
  }

  const changes = printDiffSummary(ctx.diff, ctx.isBidirectional);
  if (changes === 0) {
    console.log('没有需要同步的变化。');
    return;
  }
  await executeSync(ctx, password);
}

// ============== resolve 命令 ==============
async function cmdResolve(args) {
  const source = args._[0];
  const target = args._[1];
  const defaultChoice = args.options.source ? 'source' : args.options.target ? 'target' : args.options.both ? 'both' : null;

  if (!source || !target) {
    console.error('用法: node filesync.js resolve SOURCE TARGET [options]');
    console.error('  选项: --source  --target  --both  (默认交互式选择)');
    process.exit(1);
  }

  const conflicts = getUnresolvedConflicts(source, target);
  if (conflicts.length === 0) {
    console.log('没有未解决的冲突。');
    return;
  }

  console.log(`\n发现 ${conflicts.length} 个未解决的冲突：\n`);

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const question = (q) => new Promise(resolve => rl.question(q, resolve));

  const resolved = [];
  const skipped = [];

  for (const conflict of conflicts) {
    console.log(`冲突文件: ${conflict.relPath}`);
    console.log(`  源版本:   ${formatDate(new Date(conflict.sourceMtime))}  ${formatBytes(fs.statSync(conflict.sourceFile).size)}`);
    console.log(`  目标版本: ${formatDate(new Date(conflict.targetMtime))}  ${formatBytes(fs.statSync(conflict.targetFile).size)}`);

    let choice = defaultChoice;
    if (!choice) {
      const ans = await question('  选择保留版本 [source/target/both/skip]: ');
      choice = ans.trim().toLowerCase();
    }

    const targetDir = path.dirname(conflict.targetFile);
    const baseName = path.basename(conflict.relPath);
    const conflictFile = path.join(targetDir, baseName + CONFLICT_SUFFIX);

    if (choice === 'source') {
      fs.copyFileSync(conflict.sourceFile, conflict.targetFile);
      if (fs.existsSync(conflictFile)) fs.unlinkSync(conflictFile);
      markConflictResolved(source, target, conflict.relPath, 'source');
      updateSyncTime(source, target, conflict.relPath, Date.now());
      console.log(`  ✓ 已保留源版本\n`);
      resolved.push({ relPath: conflict.relPath, choice: 'source' });
    } else if (choice === 'target') {
      fs.copyFileSync(conflict.targetFile, conflict.sourceFile);
      if (fs.existsSync(conflictFile)) fs.unlinkSync(conflictFile);
      markConflictResolved(source, target, conflict.relPath, 'target');
      updateSyncTime(source, target, conflict.relPath, Date.now());
      console.log(`  ✓ 已保留目标版本\n`);
      resolved.push({ relPath: conflict.relPath, choice: 'target' });
    } else if (choice === 'both') {
      const ext = path.extname(baseName);
      const nameWithoutExt = path.basename(baseName, ext);
      const sourceCopy = path.join(targetDir, `${nameWithoutExt}.source${ext}`);
      fs.copyFileSync(conflict.sourceFile, sourceCopy);
      if (fs.existsSync(conflictFile)) fs.unlinkSync(conflictFile);
      markConflictResolved(source, target, conflict.relPath, 'both');
      updateSyncTime(source, target, conflict.relPath, Date.now());
      console.log(`  ✓ 已保留两个版本 (${path.basename(sourceCopy)})\n`);
      resolved.push({ relPath: conflict.relPath, choice: 'both' });
    } else {
      console.log(`  ↶ 已跳过\n`);
      skipped.push(conflict.relPath);
    }
  }

  rl.close();

  console.log(`\n完成: 已解决 ${resolved.length} 个, 跳过 ${skipped.length} 个`);
  if (resolved.length > 0) {
    resolved.forEach(r => console.log(`  [${r.choice}] ${r.relPath}`));
  }
}

// ============== decrypt 命令 ==============
async function cmdDecrypt(args) {
  const target = args._[0];
  if (!target) {
    console.error('用法: node filesync.js decrypt TARGET_DIR');
    process.exit(1);
  }

  const targetDir = resolveRemotePath(target);
  const password = await getPassword();

  const files = scanDir(targetDir, { includes: ['*' + ENC_SUFFIX] });
  const fileList = Object.values(files);

  if (fileList.length === 0) {
    console.log('没有找到加密文件。');
    return;
  }

  console.log(`\n找到 ${fileList.length} 个加密文件\n`);

  const totalBytes = fileList.reduce((sum, f) => sum + f.size, 0);
  const progress = new ProgressBar(fileList.length, '[解密]');
  progress.setTotalBytes(totalBytes);

  let success = 0, failed = 0;
  for (const f of fileList) {
    const srcPath = f.path;
    const dstPath = adjustPathForDecrypt(srcPath);
    try {
      decryptFile(srcPath, dstPath, password, progress);
      success++;
    } catch (e) {
      console.error(`\n解密失败: ${f.relPath} - ${e.message}`);
      failed++;
    }
    progress.inc();
  }

  progress.done();
  console.log(`\n完成: 成功 ${success} 个, 失败 ${failed} 个`);
}

// ============== remote 命令 ==============
function cmdRemote(args) {
  const sub = args._[0];
  const remotes = loadRemotes();

  if (!sub || sub === 'list' || sub === 'ls') {
    const names = Object.keys(remotes);
    if (!names.length) {
      console.log('暂无远程目录配置。使用: remote add NAME user@host:/path');
      return;
    }
    console.log('\n远程目录列表:\n');
    names.forEach(n => {
      const r = remotes[n];
      const mirrorPath = path.join(REMOTE_MIRRORS_DIR, n);
      const exists = fs.existsSync(mirrorPath);
      console.log(`  ${n.padEnd(15)} ${r.url.padEnd(30)} [镜像: ${mirrorPath}] [${exists ? '可达' : '不可达'}]`);
    });
    console.log();
    return;
  }

  if (sub === 'add' || sub === 'create') {
    const name = args._[1];
    const url = args._[2];
    if (!name || !url) {
      console.error('用法: remote add NAME user@host:/path');
      process.exit(1);
    }
    remotes[name] = { url, createdAt: new Date().toISOString() };
    saveRemotes(remotes);
    const mirrorPath = path.join(REMOTE_MIRRORS_DIR, name);
    ensureDir(mirrorPath);
    console.log(`远程配置 "${name}" 已添加。镜像目录: ${mirrorPath}`);
    return;
  }

  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const name = args._[1];
    if (!remotes[name]) {
      console.error(`远程配置 "${name}" 不存在`);
      process.exit(1);
    }
    delete remotes[name];
    saveRemotes(remotes);
    const mirrorPath = path.join(REMOTE_MIRRORS_DIR, name);
    if (fs.existsSync(mirrorPath)) {
      fs.rmSync(mirrorPath, { recursive: true, force: true });
    }
    console.log(`远程配置 "${name}" 已删除。`);
    return;
  }

  if (sub === 'test') {
    const name = args._[1];
    if (!name) {
      console.error('用法: remote test NAME');
      process.exit(1);
    }
    if (!remotes[name]) {
      console.error(`远程配置 "${name}" 不存在`);
      process.exit(1);
    }
    const mirrorPath = path.join(REMOTE_MIRRORS_DIR, name);
    const exists = fs.existsSync(mirrorPath);
    if (exists) {
      console.log(`✓ 远程目录 "${name}" 可达。镜像目录: ${mirrorPath}`);
    } else {
      console.log(`✗ 远程目录 "${name}" 不可达。请检查配置。`);
    }
    return;
  }

  console.error('用法: remote [list|add NAME URL|rm NAME|test NAME]');
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
async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.log(`
文件同步工具 - filesync.js

用法:
  node filesync.js <command> [args] [options]

命令:
  sync SOURCE TARGET     同步目录 (模式: mirror|push|pull|bidirectional)
  diff SOURCE TARGET     仅显示差异不同步
  resolve SOURCE TARGET  交互式处理双向同步冲突
  decrypt TARGET_DIR     解密加密目录中的 .enc 文件
  remote                 管理远程目录配置
  log                    查看同步历史日志
  undo                   回滚上次同步
  profile                管理同步配置

同步选项:
  --mode mirror          mirror(完全镜像) / push(只增不删) / pull(反向) / bidirectional(双向同步)
  --dry-run              仅显示要执行的操作
  --include PATTERN      glob 包含模式 (可多次)
  --exclude PATTERN      glob 排除模式 (可多次)
  --max-size SIZE        最大文件大小 (如 10M)
  --newer-than DATE      仅同步修改晚于该日期的文件
  --profile NAME         使用已保存的配置执行
  --encrypt              启用 AES-256 加密传输
  --set-password         交互式设置加密密码

resolve 选项:
  --source               所有冲突保留源版本
  --target               所有冲突保留目标版本
  --both                 所有冲突保留两个版本

remote 子命令:
  remote list                      列出所有远程目录
  remote add NAME user@host:/path  添加远程目录
  remote rm NAME                   删除远程目录
  remote test NAME                 检测远程目录是否可达

示例:
  node filesync.js diff source target
  node filesync.js sync source target --mode push --dry-run
  node filesync.js sync source target --mode mirror --exclude "*.log"
  node filesync.js sync source target --max-size 10M --newer-than "2024-01-01"

  # 双向同步
  node filesync.js sync source target --mode bidirectional
  node filesync.js resolve source target --source

  # 加密传输
  node filesync.js sync --set-password
  node filesync.js sync source target --encrypt
  node filesync.js decrypt target

  # 远程目录
  node filesync.js remote add myserver user@192.168.1.100:/home/user/backup
  node filesync.js remote list
  node filesync.js remote test myserver
  node filesync.js sync source remote://myserver
  node filesync.js sync remote://myserver target

  # 配置管理
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
    case 'sync': await cmdSync(parsed); break;
    case 'diff': cmdDiff(parsed); break;
    case 'resolve': await cmdResolve(parsed); break;
    case 'decrypt': await cmdDecrypt(parsed); break;
    case 'remote': cmdRemote(parsed); break;
    case 'log': case 'logs': cmdLog(parsed); break;
    case 'undo': case 'rollback': cmdUndo(parsed); break;
    case 'profile': case 'profiles': cmdProfile(parsed); break;
    default:
      console.error(`未知命令: ${cmd}`);
      process.exit(1);
  }
}

main();
