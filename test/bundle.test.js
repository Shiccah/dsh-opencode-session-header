import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * The bundle wiring the DSH plugin manager reads before it loads any code: what
 * these tests check is what makes the package selectable as a profile layer, so
 * a rename or a missing publish entry stops being a silent install failure.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patchUrl = new URL('../cordis.patch.yml', import.meta.url)

test('declares the patch file the plugin manager resolves the bundle through', () => {
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch file ships with the package')
})

test('inserts the plugin row under the bundle, naming this package', () => {
  const patch = readFileSync(patchUrl, 'utf8')
  assert.match(patch, /^- insert:\n {4}- id: opencode-session-header\n {6}name: "dsh-plugin-opencode-session-header"\n/m)
  assert.ok(patch.includes(`name: "${manifest.name}"`), 'the inserted row names the installed package')
})
