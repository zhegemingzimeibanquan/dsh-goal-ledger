// Pin market-index.json to the commit that actually contains this file's own
// version of the plugin. Run after committing; the SHA must be the commit users
// will fetch, not an earlier one.
const fs = require('fs')
const { execSync } = require('child_process')

const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
const path = 'market-index.json'
const doc = JSON.parse(fs.readFileSync(path, 'utf8'))
const before = doc.plugins[0].versions[0].source.commit

doc.plugins[0].versions[0].source.commit = sha
fs.writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8')

console.log('commit before:', before)
console.log('commit after :', sha)
console.log('changed      :', before !== sha)
