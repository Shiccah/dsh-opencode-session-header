/**
 * DeepSeek Harness plugin: send the OpenCode gateway's per-conversation session
 * header.
 *
 * OpenCode (`opencode.ai/zen`) and OpenCode Go (`opencode.ai/zen/go`) require a
 * stable per-conversation id in `x-opencode-session` on every inference request;
 * a request without it fails with `400 MissingSessionID`. `dsh-llm-pi-ai` never
 * produced that header: it passes the session id to pi-ai as a stream option, and
 * pi-ai only turns that option into affinity headers under other names.
 *
 * This plugin polyfills the missing header without patching the harness. It wraps
 * the registered pi-ai adapter so that the options object handed to pi-ai gains
 * `x-opencode-session: <session id>` for OpenCode routes. The seam already carries
 * both halves at that point: the adapter resolves the session id from the agent
 * loop and passes it, with the deployment headers, into `Models.streamSimple()`.
 *
 * Requests without a session id, and every route that is not OpenCode, pass
 * through untouched. A dynamically configured header wins over a same-named
 * static profile header, because a fixed value cannot represent per-conversation
 * identity. Every wrapper is undone when the plugin unloads.
 *
 * @module dsh-plugin-opencode-session-header
 */

/** Header the OpenCode gateway requires on every inference request. */
const DEFAULT_HEADER = 'x-opencode-session'

/** Endpoint fragments that identify the OpenCode gateway. */
const DEFAULT_HOSTS = ['opencode.ai']

/** pi-ai provider-id prefixes that identify OpenCode gateway routes. */
const DEFAULT_PROVIDER_PREFIXES = ['opencode']

export const name = 'opencode-session-header'

export const inject = ['llm']

/**
 * Install the header polyfill on every pi-ai adapter the `llm` service has
 * registered, and on every adapter it registers later.
 *
 * `ctx.llm.adapters` is read because the registry exposes no public adapter
 * enumeration. When that field is gone, this plugin cannot find the adapter it
 * wraps, so it fails at load rather than pretending to work.
 * @param ctx - the plugin's context; `llm` is injected.
 * @param config - optional plugin configuration: `header`, `hosts`, and
 *   `providerPrefixes` override the OpenCode defaults.
 * @throws {Error} when the `llm` service no longer exposes its adapter registry,
 *   which means this plugin's wrapper no longer matches the harness.
 * @throws {TypeError} when a configured value has the wrong type.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const adapters = ctx.llm?.adapters
  if (!(adapters instanceof Map)) {
    throw new Error(
      'opencode-session-header: ctx.llm.adapters is not a Map, so the plugin cannot find the pi-ai adapter it wraps.'
      + ' The harness changed its adapter registry: update or remove this plugin.',
    )
  }

  /** Adapters whose `current()` already goes through this plugin's wrapper. */
  const wrapped = new WeakSet()
  /** pi-ai model collections already carrying the header injection. */
  const injected = new WeakSet()
  /** Adapters already reported as carrying no readable pi-ai model collection. */
  const inert = new WeakSet()
  /** Undo functions restoring every wrapped method, run when this fiber disposes. */
  const undo = []

  /**
   * Wrap one pi-ai model collection. Patching the collection rather than the
   * `Models` class keeps the change inside this process's adapter instances and
   * independent of which copy of pi-ai the harness loaded.
   * @param models - the model collection of one adapter snapshot.
   * @returns whether this call installed the wrapper.
   */
  const injectIntoModels = (models) => {
    if (injected.has(models) || typeof models?.streamSimple !== 'function') return false
    const original = models.streamSimple
    const wrapper = function streamSimpleWithOpenCodeSession(model, context, streamOptions) {
      return original.call(this, model, context, withSessionHeader(model, streamOptions, options))
    }
    try {
      models.streamSimple = wrapper
    } catch (error) {
      // A frozen collection would otherwise turn every request into a failure;
      // report it once and let the request proceed without the header.
      ctx.logger?.warn?.('opencode-session-header: could not wrap the pi-ai model collection')
      ctx.logger?.warn?.(error)
      injected.add(models)
      return false
    }
    injected.add(models)
    undo.push(() => {
      // Restore the exact descriptor instead of assigning back: the collection's
      // prototype owns the real method, so a plain assignment would leave an own
      // property shadowing it after unload.
      if (Object.getOwnPropertyDescriptor(models, 'streamSimple')?.value === wrapper) {
        delete models.streamSimple
      }
      injected.delete(models)
    })
    return true
  }

  /**
   * Wrap one adapter's snapshot accessor so each snapshot's model collection
   * gains the header injection before the adapter streams through it.
   * @param adapter - a registered adapter; non-pi-ai adapters are ignored.
   */
  const wrapAdapter = (adapter) => {
    if (adapter === null || typeof adapter !== 'object' || wrapped.has(adapter)) return
    const original = adapter.current
    if (typeof original !== 'function') return
    const wrapper = function currentWithOpenCodeSession(...args) {
      const snapshot = original.apply(this, args)
      const models = snapshot?.models
      if (models !== undefined && !injectIntoModels(models) && !inert.has(adapter)) {
        inert.add(adapter)
        ctx.logger?.warn?.(
          'opencode-session-header: a pi-ai adapter exposes no model collection with streamSimple();'
          + ' the OpenCode session header is not being sent. Update or remove this plugin.',
        )
      }
      return snapshot
    }
    adapter.current = wrapper
    wrapped.add(adapter)
    undo.push(() => {
      // Same reason as for the model collection: `current` is a prototype method,
      // so restoring the exact descriptor is what actually removes the wrapper.
      if (Object.getOwnPropertyDescriptor(adapter, 'current')?.value === wrapper) {
        delete adapter.current
      }
      wrapped.delete(adapter)
    })
  }

  /** Wrap every adapter the registry currently holds. */
  const sweep = () => {
    for (const registration of adapters.values()) wrapAdapter(registration?.adapter)
  }

  sweep()
  // Route changes, settings-driven profile swaps, and HMR re-registrations
  // publish the adapter map again; the sweep is idempotent.
  ctx.on('llm/adapters-updated', sweep)
  // HMR unloads this plugin as its own fiber: restore every wrapped method so a
  // disabled plugin stops sending the header without re-mounting the adapter.
  ctx.effect(() => () => {
    for (const restore of undo.splice(0)) restore()
  })
  ctx.logger?.info?.(`opencode-session-header: sending "${options.header}" on OpenCode routes`)
}

/**
 * Add the session header to one pi-ai stream-options object when the request
 * targets an OpenCode route and carries a session id.
 * @param model - the pi-ai model descriptor the adapter resolved.
 * @param streamOptions - the options the harness built for pi-ai.
 * @param options - this plugin's resolved configuration.
 * @returns the original options when no header applies, otherwise a copy
 *   carrying the session header.
 */
function withSessionHeader(model, streamOptions, options) {
  const sessionId = streamOptions?.sessionId
  if (sessionId === undefined || sessionId === null || sessionId === '') return streamOptions
  if (!ownsRoute(model, options)) return streamOptions
  const reserved = options.header.toLowerCase()
  const headers = Object.fromEntries(
    Object.entries(streamOptions?.headers ?? {}).filter(([header]) => header.toLowerCase() !== reserved),
  )
  return { ...streamOptions, headers: { ...headers, [options.header]: String(sessionId) } }
}

/**
 * Whether one resolved route reaches the OpenCode gateway, by provider id or by
 * endpoint; the endpoint check also covers an alias route key.
 * @param model - the pi-ai model descriptor the adapter resolved.
 * @param options - this plugin's resolved configuration.
 * @returns whether requests on this route carry the header.
 */
function ownsRoute(model, options) {
  const provider = typeof model?.provider === 'string' ? model.provider : ''
  if (options.providerPrefixes.some(prefix => provider.startsWith(prefix))) return true
  const baseUrl = typeof model?.baseUrl === 'string' ? model.baseUrl : ''
  return options.hosts.some(host => baseUrl.includes(host))
}

/**
 * Validate and default the plugin configuration.
 * @param config - the raw entry configuration, or undefined.
 * @returns the resolved header name, endpoint hosts, and provider prefixes.
 * @throws {TypeError} when the configuration is not a mapping or a field has the
 *   wrong type.
 */
function resolveOptions(config) {
  if (config === undefined || config === null) {
    return { header: DEFAULT_HEADER, hosts: [...DEFAULT_HOSTS], providerPrefixes: [...DEFAULT_PROVIDER_PREFIXES] }
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('opencode-session-header: config must be a mapping')
  }
  return {
    header: stringField(config.header, DEFAULT_HEADER, 'header'),
    hosts: listField(config.hosts, DEFAULT_HOSTS, 'hosts'),
    providerPrefixes: listField(config.providerPrefixes, DEFAULT_PROVIDER_PREFIXES, 'providerPrefixes'),
  }
}

/**
 * Read one optional non-empty string field.
 * @param value - the configured value.
 * @param fallback - the value used when the field is absent.
 * @param field - the field name, for the error message.
 * @returns the configured string or the fallback.
 */
function stringField(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`opencode-session-header: config.${field} must be a non-empty string`)
  }
  return value
}

/**
 * Read one optional list-of-non-empty-strings field.
 * @param value - the configured value.
 * @param fallback - the value used when the field is absent.
 * @param field - the field name, for the error message.
 * @returns the configured list or a copy of the fallback.
 */
function listField(value, fallback, field) {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value) || value.length === 0
    || value.some(entry => typeof entry !== 'string' || entry.length === 0)) {
    throw new TypeError(`opencode-session-header: config.${field} must be a non-empty list of non-empty strings`)
  }
  return [...value]
}
