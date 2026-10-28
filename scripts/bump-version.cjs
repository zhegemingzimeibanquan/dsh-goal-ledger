// Bump the version in both places that carry it.
//
// market-index.json ships inside the package, so its version and the manifest's
// version are the same fact recorded twice. Bumping only one produces an index
// that advertises a version the tarball does not contain — which the market
// reports as an install target that 404s, with no hint about the cause.
const fs = require('fs')

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/bump-version.cjs <x.y.z>')
  process.exit(2)
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const before = pkg.version
pkg.version = version
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n', 'utf8')

const index = JSON.parse(fs.readFileSync('market-index.json', 'utf8'))
const v = index.plugins[0].versions[0]
const indexBefore = v.version
v.version = version
v.publishTimestamp = Math.floor(Date.now() / 1000)
fs.writeFileSync('market-index.json', JSON.stringify(index, null, 2) + '\n', 'utf8')

console.log('package.json      :', before, '->', version)
console.log('market-index.json :', indexBefore, '->', version)
console.log('publishTimestamp  :', v.publishTimestamp)
