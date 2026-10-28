// Compare the PUBLISHED npm tarball against a git commit.
//
// "npm publishes this tag" only means something if the bytes on the registry are
// the bytes in the tagged tree. Publishing before the final commit, or touching
// a packaged file afterwards, silently breaks that correspondence — and nothing
// in npm or git reports it.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const version = process.argv[2]
const ref = process.argv[3] ?? 'HEAD'
if (!version) { console.error('usage: node test/published-matches-tag.mjs <version> [ref]'); process.exit(2) }

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)
let failed = false
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed = true
}

// --- what the registry serves ---------------------------------------------
const metaRes = await fetch(`https://registry.npmjs.org/dsh-goal-ledger/${version}`)
if (!metaRes.ok) {
  console.error(`FAIL  ${version} is not on the registry (HTTP ${metaRes.status})`)
  process.exit(1)
}
const meta = await metaRes.json()
const tarballRes = await fetch(meta.dist.tarball)
if (!tarballRes.ok) {
  console.error(`FAIL  tarball fetch failed (HTTP ${tarballRes.status})`)
  process.exit(1)
}
const tarballBuf = Buffer.from(await tarballRes.arrayBuffer())

fs.mkdirSync('.tmp-compare', { recursive: true })
const tarPath = path.resolve(`.tmp-compare/pkg-${version}.tgz`)
fs.writeFileSync(tarPath, tarballBuf)

// Extract; tar is available on Windows 10+ and on every CI image.
const outDir = path.resolve('.tmp-compare/extract')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
execSync(`tar -xzf "${tarPath}" -C "${outDir}"`, { stdio: 'inherit' })

function walk(dir, base = dir, acc = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, acc)
    else acc.set(path.relative(base, full).split(path.sep).join('/'), full)
  }
  return acc
}

const publishedFiles = walk(path.join(outDir, 'package'))
console.log(`published ${version}: ${publishedFiles.size} files, ${tarballBuf.length} bytes\n`)

/**
 * Compare published bytes against committed bytes.
 *
 * Line endings are normalized: npm packs the working tree as-is, so on Windows
 * every text file ships with CRLF while git stores LF. That is a packing
 * artifact, not a content difference — the files are identical once normalized,
 * and refusing to normalize would make this check permanently red on Windows for
 * every release.
 *
 * Binary files are not text and get no normalization.
 */
const TEXT_EXTENSIONS = /\.(md|json|js|mjs|cjs|yml|yaml|txt)$/i
const sameContent = (relPath, publishedBuf, committedBuf) => {
  if (!TEXT_EXTENSIONS.test(relPath)) return publishedBuf.equals(committedBuf)
  const a = publishedBuf.toString('utf8').replace(/\r\n/g, '\n')
  const b = committedBuf.toString('utf8').replace(/\r\n/g, '\n')
  return a === b
}

// --- what the commit contains ---------------------------------------------
const committed = execSync(`git ls-tree -r --name-only ${ref}`, { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

// npm rewrites certain manifest fields on publish (e.g. repository shorthand,
// _id isn't present, gitHead is added), so package.json is compared field-wise
// on the things that actually describe the version, not byte-wise.
function gitShow(relPath) {
  try {
    return execSync(`git show ${ref}:${relPath}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

let compared = 0
let mismatched = []
for (const [rel, full] of publishedFiles) {
  if (rel === 'package.json') continue
  const committedText = gitShow(rel)
  if (committedText === null) {
    // A published file that the tag does not contain is the dangerous case.
    mismatched.push(`${rel} (not in ${ref})`)
    continue
  }
  const publishedBuf = fs.readFileSync(full)
  const committedBuf = Buffer.from(committedText, 'utf8')
  compared++
  if (!sameContent(rel, publishedBuf, committedBuf)) {
    mismatched.push(`${rel} (published ${hash(publishedBuf)} != tag ${hash(committedBuf)})`)
  }
}

check('every published file exists in the tag', mismatched.every(m => !m.includes('not in')),
  mismatched.filter(m => m.includes('not in')).join('; ') || 'none missing')
check('every published file matches the tag', mismatched.length === 0,
  mismatched.length ? mismatched.join('; ') : `${compared} files compared (text normalized to LF)`)

// --- package.json identity fields -----------------------------------------
const pubPkg = JSON.parse(fs.readFileSync(path.join(outDir, 'package', 'package.json'), 'utf8'))
const tagPkg = JSON.parse(gitShow('package.json') ?? '{}')
check('published version equals the tag version', pubPkg.version === tagPkg.version,
  `published ${pubPkg.version} vs tag ${tagPkg.version}`)
for (const field of ['engines', 'dsh', 'exports', 'files']) {
  check(`published ${field} matches the tag`,
    JSON.stringify(pubPkg[field]) === JSON.stringify(tagPkg[field]),
    JSON.stringify(pubPkg[field]) === JSON.stringify(tagPkg[field]) ? '' : 'differs')
}

// --- files the tag has that npm intentionally does not ship ----------------
const shipped = new Set(publishedFiles.keys())
const shouldShip = tagPkg.files ?? []
const missingFromTarball = committed.filter(f =>
  shouldShip.some(prefix => f === prefix || f.startsWith(prefix + '/'))
  && !shipped.has(f) && !f.endsWith('package.json'))
check('every packaged path declared in files[] is present', missingFromTarball.length === 0,
  missingFromTarball.join('; ') || `${shipped.size} shipped of ${committed.length} tracked`)

fs.rmSync('.tmp-compare', { recursive: true, force: true })
console.log(failed ? '\nFAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)
