// Point the market index at the npm-published version.
//
// The index previously named a commit-pinned Git source, because npm publishing
// was blocked. Now that 0.2.0 is on the registry, npm is the better target: a
// 48.6 kB tarball instead of cloning the repository, and version-resolution
// semantics users already understand.
const fs = require('fs')

const path = 'market-index.json'
const doc = JSON.parse(fs.readFileSync(path, 'utf8'))
const version = doc.plugins[0].versions[0]

const before = JSON.stringify(version.source)
version.source = { type: 'npm' }
fs.writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8')

console.log('source before:', before)
console.log('source after :', JSON.stringify(version.source))
console.log('version      :', version.version)
