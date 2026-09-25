import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, inject, name } from '../index.js'

/** A stand-in for the pi-ai adapter: `current()` hands back one snapshot. */
function fakeAdapter(models) {
  return {
    snapshots: 0,
    current() {
      this.snapshots += 1
      return { profiles: new Map(), models }
    },
  }
}

/** A stand-in for the pi-ai `Models` collection. */
function fakeModels() {
  return {
    calls: [],
    streamSimple(model, context, streamOptions) {
      this.calls.push({ model, context, streamOptions })
      return 'stream'
    },
  }
}

/** A stand-in for the plugin context, exposing the registry the plugin reads. */
function fakeContext(entries) {
  const adapters = new Map(entries.map(([provider, adapter]) => [provider, { adapter }]))
  const events = []
  const cleanups = []
  const logs = []
  return {
    adapters,
    events,
    cleanups,
    logs,
    ctx: {
      llm: { adapters },
      on(event, listener) {
        events.push({ event, listener })
        return () => {}
      },
      effect(callback) {
        const disposer = callback()
        cleanups.push(disposer)
        return disposer
      },
      logger: {
        info: message => logs.push({ level: 'info', message }),
        warn: message => logs.push({ level: 'warn', message }),
      },
    },
  }
}

test('plugin declares the harness contract', () => {
  assert.equal(name, 'opencode-session-header')
  assert.deepEqual(inject, ['llm'])
})

test('adds the session header on an opencode provider route', () => {
  const models = fakeModels()
  const adapter = fakeAdapter(models)
  const { ctx } = fakeContext([['opencode-go', adapter]])
  apply(ctx)

  adapter.current().models.streamSimple(
    { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' },
    { messages: [] },
    { sessionId: 'session-1234', headers: { 'x-app': 'dsh' } },
  )

  assert.deepEqual(models.calls[0].streamOptions.headers, {
    'x-app': 'dsh',
    'x-opencode-session': 'session-1234',
  })
})

test('adds the header for an alias route key pointing at the gateway', () => {
  const models = fakeModels()
  const adapter = fakeAdapter(models)
  const { ctx } = fakeContext([['console-go', adapter]])
  apply(ctx)

  adapter.current().models.streamSimple(
    { provider: 'console-go', baseUrl: 'https://opencode.ai/zen/go/v1' },
    {},
    { sessionId: 'session-alias' },
  )

  assert.equal(models.calls[0].streamOptions.headers['x-opencode-session'], 'session-alias')
})

test('leaves requests without a session id and other routes untouched', () => {
  const models = fakeModels()
  const adapter = fakeAdapter(models)
  const { ctx } = fakeContext([['opencode-go', adapter]])
  apply(ctx)

  const withoutSession = { headers: { 'x-app': 'dsh' } }
  const returned = adapter.current().models.streamSimple(
    { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' },
    {},
    withoutSession,
  )
  assert.equal(returned, 'stream')
  assert.equal(models.calls[0].streamOptions, withoutSession)

  const otherRoute = { sessionId: 'session-deepseek', headers: {} }
  adapter.current().models.streamSimple(
    { provider: 'deepseek', baseUrl: 'https://api.deepseek.com' },
    {},
    otherRoute,
  )
  assert.equal(models.calls[1].streamOptions, otherRoute)
})

test('replaces a same-named static header regardless of letter case', () => {
  const models = fakeModels()
  const adapter = fakeAdapter(models)
  const { ctx } = fakeContext([['opencode-go', adapter]])
  apply(ctx)

  adapter.current().models.streamSimple(
    { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' },
    {},
    { sessionId: 'session-live', headers: { 'X-OpenCode-Session': 'static-id' } },
  )

  assert.deepEqual(models.calls[0].streamOptions.headers, { 'x-opencode-session': 'session-live' })
})

test('covers adapters registered after the plugin mounted', () => {
  const models = fakeModels()
  const adapter = fakeAdapter(models)
  const { ctx, adapters, events } = fakeContext([])
  apply(ctx)

  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'llm/adapters-updated')

  adapters.set('opencode', { adapter })
  events[0].listener()
  adapter.current().models.streamSimple(
    { provider: 'opencode', baseUrl: 'https://opencode.ai/zen/v1' },
    {},
    { sessionId: 'session-late' },
  )

  assert.equal(models.calls[0].streamOptions.headers['x-opencode-session'], 'session-late')
})

test('ignores adapters that are not pi-ai adapters', () => {
  const other = { stream() { return 'other' } }
  const { ctx, logs } = fakeContext([['deepseek', other]])
  apply(ctx)

  assert.equal(other.current, undefined)
  assert.equal(logs.filter(log => log.level === 'warn').length, 0)
})

test('wraps one collection once across repeated snapshots', () => {
  const models = fakeModels()
  const adapter = fakeAdapter(models)
  const { ctx } = fakeContext([['opencode-go', adapter]])
  apply(ctx)

  const first = adapter.current().models
  const second = adapter.current().models
  assert.equal(first, second)
  first.streamSimple({ provider: 'opencode-go' }, {}, { sessionId: 'session-once' })
  assert.equal(models.calls.length, 1)
  assert.equal(adapter.current().models.streamSimple, first.streamSimple)
})

test('restores every wrapped method when the plugin unloads', () => {
  const models = fakeModels()
  const adapter = fakeAdapter(models)
  const originalCurrent = adapter.current
  const originalStreamSimple = models.streamSimple
  const { ctx, cleanups } = fakeContext([['opencode-go', adapter]])
  apply(ctx)

  assert.equal(cleanups.length, 1)
  cleanups[0]()

  assert.equal(adapter.current, originalCurrent)
  assert.equal(models.streamSimple, originalStreamSimple)
  adapter.current().models.streamSimple(
    { provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' },
    {},
    { sessionId: 'session-after-unload', headers: {} },
  )
  assert.equal(models.calls[0].streamOptions.headers['x-opencode-session'], undefined)
})

test('honors configuration overrides', () => {
  const models = fakeModels()
  const adapter = fakeAdapter(models)
  const { ctx } = fakeContext([['acme-opencode', adapter]])
  apply(ctx, { header: 'x-gateway-session', hosts: ['gateway.acme.example'], providerPrefixes: ['acme'] })

  adapter.current().models.streamSimple(
    { provider: 'acme-opencode', baseUrl: 'https://gateway.acme.example/v1' },
    {},
    { sessionId: 'session-acme' },
  )

  assert.deepEqual(models.calls[0].streamOptions.headers, { 'x-gateway-session': 'session-acme' })
})

test('rejects a malformed configuration and a changed adapter registry', () => {
  const { ctx } = fakeContext([])
  assert.throws(() => apply(ctx, { header: '' }), TypeError)
  assert.throws(() => apply(ctx, { hosts: [] }), TypeError)
  assert.throws(() => apply(ctx, [1]), TypeError)
  assert.throws(() => apply({ llm: {}, logger: {} }), /adapters is not a Map/)
})
