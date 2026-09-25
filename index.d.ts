/**
 * DeepSeek Harness plugin: send the OpenCode gateway's per-conversation session
 * header. See `README.md` for the plugin contract and failure modes.
 *
 * @module dsh-plugin-opencode-session-header
 */

import type { Context } from '@deepseek-ai/cordis'

/** Plugin name reported to the harness loader. */
export declare const name = 'opencode-session-header'

/** The plugin needs the LLM service to reach the registered pi-ai adapter. */
export declare const inject: ['llm']

/** Optional overrides for the OpenCode defaults. */
export interface Config {
  /** Header the gateway requires; defaults to `x-opencode-session`. */
  header?: string
  /** Endpoint fragments identifying the gateway; defaults to `['opencode.ai']`. */
  hosts?: string[]
  /** pi-ai provider-id prefixes identifying gateway routes; defaults to `['opencode']`. */
  providerPrefixes?: string[]
}

/**
 * Install the header polyfill on every registered pi-ai adapter and on every
 * adapter registered later.
 * @param ctx - the plugin's context; `llm` is injected.
 * @param config - optional overrides for the OpenCode defaults.
 */
export declare function apply(ctx: Context, config?: Config): void
