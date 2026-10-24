/**
 * 手工装配：把本插件挂进 DSH 的 desktop profile。
 *
 * 为什么不走 `dsh plugin add`：那个 profile 里有一条 `"dsh-speak-up": "*"`,
 * npm 上没有这个包，pnpm 重新解析依赖时会 404 整个失败。
 * 这里只做三件事，不动任何现有插件：
 *   1) dependencies 里加一条 link:
 *   2) dsh.profile.bundles 里加个名字
 *   3) 建 node_modules 链接（由调用方用 junction 完成）
 *
 * 幂等：重复跑结果一样。首次运行会留一份 package.json.bak-qqpersona。
 *
 * 跑法：node scripts/patch-profile.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const profileFlag = argv.indexOf('--profile');
const PROFILE = profileFlag >= 0 && argv[profileFlag + 1]
  ? path.resolve(argv[profileFlag + 1])
  : process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');

const NAME = 'dsh-qq-persona';
const dry = argv.includes('--dry');

const pkgPath = path.join(PROFILE, 'package.json');
const raw = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);

const before = JSON.stringify(pkg);

pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
pkg.dependencies[NAME] = `link:${PLUGIN}`;

pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
if (!bundles.includes(NAME)) bundles.push(NAME);
pkg.dsh.profile.bundles = bundles;

const after = JSON.stringify(pkg);
if (before === after) {
  console.log('已经装配过了，什么都没改。');
  process.exit(0);
}

if (dry) {
  console.log('--dry：本来会写这些改动');
  console.log('  dependencies["' + NAME + '"] = link:' + PLUGIN);
  console.log('  bundles += ' + NAME);
  process.exit(0);
}

const bak = `${pkgPath}.bak-qqpersona`;
if (!fs.existsSync(bak)) {
  fs.writeFileSync(bak, raw, 'utf8');
  console.log(`已备份 → ${bak}`);
}

fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`已写入 ${pkgPath}`);
console.log(`  dependencies["${NAME}"] = link:${PLUGIN}`);
console.log(`  bundles 共 ${bundles.length} 项，末尾是 ${bundles[bundles.length - 1]}`);