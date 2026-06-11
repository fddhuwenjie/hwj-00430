const fs = require('fs');
const path = require('path');

const base = __dirname;
const srcDir = path.join(base, 'source');
const tgtDir = path.join(base, 'target');
const appDir = path.join(base, '.filesync');

function rmDir(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function reset() {
  console.log('清理旧数据...');
  rmDir(srcDir);
  rmDir(tgtDir);
  rmDir(appDir);

  console.log('创建目录结构...');
  fs.mkdirSync(path.join(srcDir, 'subdir'), { recursive: true });
  fs.mkdirSync(path.join(tgtDir, 'subdir'), { recursive: true });

  console.log('创建源目录文件...');
  fs.writeFileSync(path.join(srcDir, 'fileA.txt'), '这是文件A的内容 - 源版本\n包含源目录特有的数据\n');
  fs.writeFileSync(path.join(srcDir, 'fileB.txt'), '共享文件 - 内容相同\n两个目录中此文件完全一致\n');
  fs.writeFileSync(path.join(srcDir, 'fileC.txt'), '源目录独有文件C\n只在源目录中存在\n');
  fs.writeFileSync(path.join(srcDir, 'subdir', 'fileD.txt'), '子目录文件D - 源\n这是子目录中的源版本内容\n');
  fs.writeFileSync(path.join(srcDir, '.syncignore'),
    '# .syncignore 示例\nnode_modules/\n*.log\ntemp/\n*.tmp\n.DS_Store\n');

  console.log('创建大文件（含可复用块，用于测试增量传输）...');
  let src = '文件头 - 源版本\n';
  const blockSize = 4096;
  for (let b = 0; b < 4; b++) {
    let block = '';
    for (let i = 0; i < blockSize; i++) block += String.fromCharCode(65 + b);
    src += block + '\n';
  }
  src += '源文件独有内容（变化块）\n';
  for (let i = 1; i <= 500; i++)
    src += '行' + i + ': 这是源新增的尾部内容数据行 ' + i + '\n';
  fs.writeFileSync(path.join(srcDir, 'bigfile.txt'), src);

  console.log('创建目标目录文件（有差异）...');
  fs.writeFileSync(path.join(tgtDir, 'fileA.txt'), '这是文件A的内容 - 目标旧版本\n旧的目标内容\n');
  fs.writeFileSync(path.join(tgtDir, 'fileB.txt'), '共享文件 - 内容相同\n两个目录中此文件完全一致\n');
  fs.writeFileSync(path.join(tgtDir, 'fileE.txt'), '目标目录独有文件E\n只在目标目录中存在\n');
  fs.writeFileSync(path.join(tgtDir, 'subdir', 'fileD.txt'), '子目录文件D - 旧目标\n旧的子目录内容\n');

  let tgt = '文件头 - 旧版本\n';
  for (let b = 0; b < 4; b++) {
    let block = '';
    for (let i = 0; i < blockSize; i++) block += String.fromCharCode(65 + b);
    tgt += block + '\n';
  }
  tgt += '目标文件旧尾部\n';
  for (let i = 1; i <= 200; i++)
    tgt += '行' + i + ': 这是目标旧尾部数据行 ' + i + '\n';
  fs.writeFileSync(path.join(tgtDir, 'bigfile.txt'), tgt);

  const oldTime = new Date('2024-01-01T12:00:00');
  const newTime = new Date('2024-06-01T12:00:00');
  const sameTime = new Date('2024-03-15T12:00:00');

  ['target/fileA.txt', 'target/bigfile.txt', 'target/subdir/fileD.txt'].forEach(f =>
    fs.utimesSync(path.join(base, f), oldTime, oldTime));
  ['source/fileA.txt', 'source/bigfile.txt', 'source/subdir/fileD.txt'].forEach(f =>
    fs.utimesSync(path.join(base, f), newTime, newTime));

  fs.utimesSync(path.join(srcDir, 'fileB.txt'), sameTime, sameTime);
  fs.utimesSync(path.join(tgtDir, 'fileB.txt'), sameTime, sameTime);
  fs.utimesSync(path.join(srcDir, '.syncignore'), newTime, newTime);
  fs.utimesSync(path.join(srcDir, 'fileC.txt'), newTime, newTime);
  fs.utimesSync(path.join(tgtDir, 'fileE.txt'), oldTime, oldTime);

  console.log('\n演示目录初始化完成！\n');
  console.log('源目录 (source):');
  console.log('  + fileA.txt       (内容较新，和目标不同)');
  console.log('  + fileB.txt       (与目标完全相同，用于测试未变检测)');
  console.log('  + fileC.txt       (源独有，测试新增)');
  console.log('  + bigfile.txt     (包含500行，测试增量传输)');
  console.log('  + subdir/fileD.txt(子目录文件，较新版本)');
  console.log('  + .syncignore     (忽略规则文件)');
  console.log('');
  console.log('目标目录 (target):');
  console.log('  + fileA.txt       (旧版本)');
  console.log('  + fileB.txt       (相同)');
  console.log('  + fileE.txt       (目标独有，测试删除)');
  console.log('  + bigfile.txt     (仅400行，旧内容)');
  console.log('  + subdir/fileD.txt(旧版本)');
  console.log('');
  console.log('下一步可运行:');
  console.log('  node filesync.js diff source target');
  console.log('  node filesync.js sync source target --mode push --dry-run');
  console.log('  node filesync.js sync source target --mode mirror');
}

reset();
