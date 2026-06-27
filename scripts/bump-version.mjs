#!/usr/bin/env node
/**
 * 从 git tag(形如 v1.2.3)取版本号写入根 package.json,供 CI 发布流程使用。
 * 本地无 tag 环境运行时为 no-op(保持当前版本)。参照 auto-cr 的发布脚本,
 * 适配为单包(tracelane 不是 monorepo)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PKG = join(process.cwd(), 'package.json');

/** 从 TAG_VERSION / GITHUB_REF 解析出 1.2.3(去掉前缀 v) */
function extractTagVersion() {
  const raw = process.env.TAG_VERSION || process.env.GITHUB_REF_NAME || process.env.GITHUB_REF;
  if (!raw) return null;
  const m = raw.replace(/^refs\/tags\//, '').match(/^v(\d+\.\d+\.\d+(?:[-+].*)?)$/);
  return m ? m[1] : null;
}

function numericParts(v) {
  const [maj, min, patchMeta = '0'] = v.split('.');
  const patch = Number((patchMeta.match(/^\d+/) ?? ['0'])[0]);
  const parts = [Number(maj), Number(min), patch];
  if (parts.some(Number.isNaN)) throw new Error(`Invalid semver: ${v}`);
  return parts;
}

function compare(a, b) {
  const pa = numericParts(a);
  const pb = numericParts(b);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

const pkg = JSON.parse(readFileSync(PKG, 'utf-8'));
const tag = extractTagVersion();

if (!tag) {
  console.log(`未找到 tag 版本,保持 ${pkg.version}`);
  process.exit(0);
}
if (compare(tag, pkg.version) < 0) {
  console.warn(`tag ${tag} 低于当前 ${pkg.version},保持当前版本(疑似打错 tag)`);
  process.exit(0);
}
if (pkg.version === tag) {
  console.log(`package.json 已是 ${tag},无需修改`);
  process.exit(0);
}

pkg.version = tag;
writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`版本更新为 ${tag}`);
