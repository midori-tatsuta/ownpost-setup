// OwnPost: set up / update. Run by GitHub Actions in your own repository
// ("Actions" -> "OwnPostを設置・更新" -> "Run workflow").
//
// 1. downloads the newest OwnPost with your buyer code (OWNPOST_KEY)
// 2. merges it into this repository (your own changes in app/ are kept;
//    if they collide with the new version, a pull request explains where)
// 3. deploys it to your Cloudflare account (database and file storage are
//    created on the first run)
//
// No dependencies: Node 20+, git and tar, as on GitHub's runners.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DIST_URL_DEFAULT = 'https://ownpost-dist.midori-tatsuta.workers.dev';
export const WRANGLER = 'wrangler@4.147.0';
export const RELEASE_BRANCH = 'ownpost-release';
const APP_DIR = 'app';
const INSTALLER_PATH = '.github/ownpost/update.mjs';

// ------------------------------------------------------------------ helpers

export function compareVersions(a, b) {
  const pa = String(a || '0.0.0').split('.').map(Number);
  const pb = String(b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** Problems with the repository secrets, in plain Japanese (empty = OK). */
export function checkSettings(env) {
  const problems = [];
  const need = [
    ['OWNPOST_KEY', '購入者コード（Brainの記事に書かれているもの）'],
    ['CLOUDFLARE_API_TOKEN', 'CloudflareのAPIトークン'],
    ['CLOUDFLARE_ACCOUNT_ID', 'CloudflareのアカウントID'],
    ['ADMIN_PASSWORD', '管理画面のパスワード'],
    ['ENCRYPTION_KEY', '暗号化の合言葉'],
  ];
  for (const [name, what] of need) {
    if (!String(env[name] || '').trim()) problems.push(`${name}（${what}）が設定されていません。「Settings」→「Secrets and variables」→「Actions」で追加してください`);
  }
  if (env.ADMIN_PASSWORD && String(env.ADMIN_PASSWORD).length < 8) problems.push('ADMIN_PASSWORD は8文字以上にしてください');
  if (env.ENCRYPTION_KEY && String(env.ENCRYPTION_KEY).length < 20) problems.push('ENCRYPTION_KEY は20文字以上の長い文字列にしてください');
  if (env.CLOUDFLARE_ACCOUNT_ID && !/^[0-9a-f]{32}$/.test(String(env.CLOUDFLARE_ACCOUNT_ID).trim())) {
    problems.push('CLOUDFLARE_ACCOUNT_ID の形が違います（32文字の英数字です）。Cloudflareのダッシュボードの右側に出ている「Account ID」を貼ってください');
  }
  if (env.REPO_PRIVATE === 'false') problems.push('このリポジトリが公開（Public）になっています。「Settings」→いちばん下の「Change repository visibility」で非公開（Private）にしてから、もう一度実行してください');
  return problems;
}

/** The workers.dev (or custom) URL wrangler printed after deploying. */
export function parseWorkerUrl(output) {
  const m = String(output).match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i) || String(output).match(/https:\/\/[^\s]+/);
  return m ? m[0] : null;
}

/** Turn common wrangler failures into something a beginner can act on. */
export function explainDeployError(output) {
  const s = String(output);
  if (/workers\.dev subdomain|register a workers\.dev/i.test(s)) {
    return 'Cloudflareで workers.dev のサブドメインがまだ決まっていません。Cloudflareのダッシュボードで「Workers & Pages」を一度開き、サブドメインを決めてから、もう一度実行してください';
  }
  if (/enable R2|R2 is not enabled|code: 10042/i.test(s)) {
    return 'CloudflareでR2（画像置き場）がまだ有効になっていません。ダッシュボードの「R2」を開いて有効にしてから、もう一度実行してください（無料枠の範囲なら料金はかかりません）';
  }
  if (/Authentication error|code: 10000|Invalid API Token|9109/i.test(s)) {
    return 'CloudflareのAPIトークンが使えませんでした。トークンの権限（Workers Scripts・D1・Workers R2 Storage の編集）と、CLOUDFLARE_ACCOUNT_ID が合っているか確認してください';
  }
  return 'Cloudflareへの設置に失敗しました。下の「Deploy」のログの英語の部分を、そのままClaudeに見せると原因を調べてもらえます';
}

function sh(cmd, args, { cwd, env, input } = {}) {
  return execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function tryRun(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// ------------------------------------------------------------------ distribution server

async function getJson(url, init, fetchImpl) {
  const res = await fetchImpl(url, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  return { status: res.status, body };
}

export async function fetchLatest(distUrl, fetchImpl = fetch) {
  const { status, body } = await getJson(`${distUrl}/latest.json`, {}, fetchImpl);
  if (status !== 200 || !body?.version) throw new UserError('配布元から最新の版を確かめられませんでした。少し時間をおいて、もう一度実行してください');
  return body;
}

export async function checkCode(distUrl, key, fetchImpl = fetch) {
  const { status, body } = await getJson(`${distUrl}/check`, { headers: { Authorization: `Bearer ${key}` } }, fetchImpl);
  if (status !== 200) throw new UserError(body?.message || '購入者コードを確かめられませんでした');
}

export async function downloadRelease(distUrl, key, version, dest, fetchImpl = fetch) {
  const res = await fetchImpl(`${distUrl}/releases/${version}.tar.gz`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status !== 200) {
    let message = `版 ${version} をダウンロードできませんでした`;
    try {
      message = (await res.json()).message || message;
    } catch {
      // keep the default
    }
    throw new UserError(message);
  }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export class UserError extends Error {}

// ------------------------------------------------------------------ git

function currentVersion(repoDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoDir, APP_DIR, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/**
 * Put the release on the "ownpost-release" branch (pristine copies only),
 * then merge it into the current branch. Git's three-way merge keeps the
 * owner's own changes; a collision becomes a pull request instead of a
 * broken deploy. Returns 'merged' | 'unchanged' | 'conflict'.
 */
export function applyRelease({ repoDir, extracted, version, git = (args, cwd = repoDir) => sh('git', args, { cwd }), openPullRequest }) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ownpost-release-'));
  const hasRemote = git(['ls-remote', '--heads', 'origin', RELEASE_BRANCH]).length > 0;
  try {
    if (hasRemote) {
      git(['fetch', 'origin', `${RELEASE_BRANCH}:refs/remotes/origin/${RELEASE_BRANCH}`]);
      git(['worktree', 'add', '-B', RELEASE_BRANCH, work, `origin/${RELEASE_BRANCH}`]);
    } else {
      git(['worktree', 'add', '--detach', work]);
      git(['checkout', '--orphan', RELEASE_BRANCH], work);
      git(['rm', '-rf', '--quiet', '.'], work);
    }
    fs.rmSync(path.join(work, APP_DIR), { recursive: true, force: true });
    fs.cpSync(path.join(extracted, APP_DIR), path.join(work, APP_DIR), { recursive: true });
    git(['add', '-A', APP_DIR], work);
    const staged = tryRun('git', ['diff', '--cached', '--quiet'], { cwd: work });
    if (!staged.ok) {
      git(['commit', '--quiet', '-m', `OwnPost v${version}`], work);
      git(['push', '--quiet', 'origin', `${RELEASE_BRANCH}:${RELEASE_BRANCH}`], work);
    }
  } finally {
    tryRun('git', ['worktree', 'remove', '--force', work], { cwd: repoDir });
    fs.rmSync(work, { recursive: true, force: true });
  }

  const before = git(['rev-parse', 'HEAD']);
  const merged = tryRun('git', ['merge', '--no-edit', '--allow-unrelated-histories', '-m', `OwnPost v${version} を取り込み`, RELEASE_BRANCH], { cwd: repoDir });
  if (!merged.ok) {
    tryRun('git', ['merge', '--abort'], { cwd: repoDir });
    openPullRequest?.({ base: branch, head: RELEASE_BRANCH, version });
    return 'conflict';
  }
  // the installer itself is updated from the release, outside app/
  const nextInstaller = path.join(extracted, 'installer', 'update.mjs');
  const here = path.join(repoDir, INSTALLER_PATH);
  if (fs.existsSync(nextInstaller) && (!fs.existsSync(here) || fs.readFileSync(nextInstaller, 'utf8') !== fs.readFileSync(here, 'utf8'))) {
    fs.mkdirSync(path.dirname(here), { recursive: true });
    fs.copyFileSync(nextInstaller, here);
    git(['add', INSTALLER_PATH]);
    git(['commit', '--quiet', '-m', `OwnPost v${version} の設置スクリプト`]);
  }
  const after = git(['rev-parse', 'HEAD']);
  if (after === before) return 'unchanged';
  git(['push', '--quiet', 'origin', `HEAD:${branch}`]);
  return 'merged';
}

// ------------------------------------------------------------------ deploy

export function deploy({ appDir, env, repoUrl, distUrl, run = tryRun }) {
  const secrets = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ownpost-secrets-')), 'secrets.json');
  fs.writeFileSync(secrets, JSON.stringify({ ADMIN_PASSWORD: env.ADMIN_PASSWORD, ENCRYPTION_KEY: env.ENCRYPTION_KEY }), { mode: 0o600 });
  try {
    const args = ['--yes', WRANGLER, 'deploy', '--secrets-file', secrets, '--var', `OWNPOST_REPO:${repoUrl}`, '--var', `OWNPOST_DIST_URL:${distUrl}`];
    if (env.OWNPOST_DRY_RUN === 'true') args.push('--dry-run'); // checks the build without uploading (for testing the installer)
    const res = run('npx', args, {
      cwd: appDir,
      env: { CI: 'true', CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: String(env.CLOUDFLARE_ACCOUNT_ID).trim(), WRANGLER_SEND_METRICS: 'false' },
    });
    console.log(res.out); // wrangler's own log (it never prints secret values)
    if (!res.ok) throw new UserError(explainDeployError(res.out));
    return parseWorkerUrl(res.out);
  } finally {
    fs.rmSync(path.dirname(secrets), { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ main

function summary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, `${lines.join('\n')}\n`);
  for (const l of lines) console.log(l);
}

function openPullRequestWithGh({ base, head, version }) {
  const body = [
    `OwnPost v${version} を取り込もうとしたところ、このリポジトリで変えた部分（改造）と、新しい版の変更が同じ場所でぶつかりました。`,
    '',
    'いまのツールはそのまま動いています（新しい版はまだ設置していません）。',
    '',
    '直し方：Claude Code などで、このリポジトリを開いて「このプルリクエストのぶつかった部分を直して」と頼んでください。直してこのプルリクエストを取り込んだあと、もう一度「OwnPostを設置・更新」を実行します。',
  ].join('\n');
  const existing = tryRun('gh', ['pr', 'list', '--head', head, '--base', base, '--state', 'open', '--json', 'number', '--jq', 'length']);
  if (existing.ok && existing.out.trim() !== '0') return;
  tryRun('gh', ['pr', 'create', '--base', base, '--head', head, '--title', `OwnPost v${version} への更新（改造した部分とぶつかりました）`, '--body', body]);
}

export async function main(env = process.env) {
  const distUrl = (env.OWNPOST_DIST_URL || DIST_URL_DEFAULT).replace(/\/$/, '');
  const repoDir = env.GITHUB_WORKSPACE || process.cwd();
  const repoUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}` : '';

  const problems = checkSettings(env);
  if (problems.length) throw new UserError(problems.join('\n'));
  await checkCode(distUrl, env.OWNPOST_KEY);

  const latest = await fetchLatest(distUrl);
  const current = currentVersion(repoDir);
  const force = env.FORCE === 'true';
  let state = 'unchanged';

  const deployOnly = env.DEPLOY_ONLY === 'true' && current; // a push of your own changes: just deploy them
  if (!deployOnly && (!current || force || compareVersions(latest.version, current) > 0)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ownpost-dl-'));
    const archive = path.join(tmp, 'ownpost.tar.gz');
    await downloadRelease(distUrl, env.OWNPOST_KEY, latest.version, archive);
    sh('tar', ['-xzf', archive, '-C', tmp]);
    const extracted = path.join(tmp, 'ownpost');
    sh('git', ['config', 'user.name', 'OwnPost installer'], { cwd: repoDir });
    sh('git', ['config', 'user.email', 'ownpost-installer@users.noreply.github.com'], { cwd: repoDir });
    state = applyRelease({ repoDir, extracted, version: latest.version, openPullRequest: openPullRequestWithGh });
    if (state === 'conflict') {
      throw new UserError(`新しい版（v${latest.version}）と、このリポジトリで改造した部分がぶつかりました。いまのツールはそのまま動いています。「Pull requests」に直し方をまとめたので、そちらを見てください`);
    }
  }

  const url = deploy({ appDir: path.join(repoDir, APP_DIR), env, repoUrl, distUrl });
  const version = currentVersion(repoDir);
  summary([
    `## OwnPost v${version} を設置しました`,
    '',
    state === 'merged' && current ? `v${current} から v${version} に更新しました。` : state === 'merged' ? 'はじめての設置が終わりました。' : deployOnly ? 'app/ の変更（改造）を反映しました。' : 'いまの版を設置し直しました。',
    '',
    url ? `管理画面：${url}` : '管理画面のURLは、Cloudflareのダッシュボードの「Workers & Pages」→「ownpost」で確認できます。',
    '',
    ...(Array.isArray(latest.notes) && state === 'merged' ? ['### この版で変わったこと', ...latest.notes.map((n) => `- ${n}`)] : []),
  ]);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    const message = err instanceof UserError ? err.message : `思わぬエラーで止まりました：${err?.message || err}`;
    for (const line of message.split('\n')) console.log(`::error title=OwnPost::${line}`);
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) fs.appendFileSync(file, `## OwnPost を設置できませんでした\n\n${message.split('\n').map((l) => `- ${l}`).join('\n')}\n`);
    process.exit(1);
  });
}
