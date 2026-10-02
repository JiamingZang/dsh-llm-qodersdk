/**
 * Register {@link QoderAdapter} for the `qoder` and `qoder-byok` provider
 * routes on `ctx.llm`. The inner sessions ride on the local `qodercli` login
 * state through the qoder-agent-sdk: the advertised model catalog is fetched
 * live from the CLI and split into the account's built-in models (`qoder`)
 * and its custom models (`qoder-byok`), every model is addressable by its SDK
 * value (plus the two `deepseek-v4-*` aliases), and warm inner sessions close
 * with the plugin.
 * @module dsh-llm-qoder
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import { QoderAdapter, QODER_BYOK_PROVIDER, QODER_PROVIDER } from './adapter.ts'

export { QoderAdapter, QODER_PROVIDER, QODER_BYOK_PROVIDER } from './adapter.ts'
export type { ImageRequestReader, QoderAdapterOptions } from './adapter.ts'
export { QoderSession, QoderSessionManager } from './session.ts'
export { QODER_MODELS, resolveQoderModelId } from './catalog.ts'
export { QoderModelCatalog } from './models.ts'

export const name = 'llm-qoder'
export const inject = ['llm']

/**
 * Configuration namespace: the profile entry id this plugin is mounted under,
 * which is what the settings service and the configurable-provider directory
 * address. The plugin's own `Config` schema is the form source, so nothing has
 * to be registered against the settings service by hand.
 */
const NS = 'llm-qoder'

/** Encoded-byte ceiling for one forwarded request image, before base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1_048_576

/** Plugin config; the adapter works entirely off local qodercli auth. */
export interface Config {
  /** Maximum simultaneously warm inner qodercli sessions. */
  maxSessions?: number
  /** Seconds a fetched CLI model catalog stays fresh before re-fetching. */
  modelCacheTtlSeconds?: number
}

export const Config: z<Config> = z.object({
  maxSessions: z.number().step(1).min(1).max(64).default(8),
  modelCacheTtlSeconds: z.number().step(1).min(10).max(86_400).default(300),
})

export function apply(ctx: Context, config: Config): void {
  let attachments: AttachmentStore | undefined
  const adapter = new QoderAdapter({
    maxSessions: config.maxSessions ?? 8,
    modelCacheTtlMs: (config.modelCacheTtlSeconds ?? 300) * 1000,
    // Images reach the inner model only through the host attachment store, so
    // this stays a lazy lookup. An unmounted store leaves the adapter with no
    // reader, and images degrade to the harness's own handle text instead of
    // failing the turn — which is also why `attachments` is not a hard inject:
    // the provider routes must register even on a deployment without one.
    readImage: (ref, signal) => {
      const store = attachments
      if (store === undefined) return Promise.resolve(undefined)
      // Ask for the attachment's own dimensions: the host already normalized
      // it, so only the byte ceiling binds the request version.
      return store.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: REQUEST_IMAGE_MAX_BYTES }, signal)
        .then(image => ({ bytes: image.data, mediaType: image.mediaType }))
    },
  })
  ctx.inject(['attachments'], (scope) => {
    attachments = scope.attachments
    scope.effect(() => () => { attachments = undefined }, 'llm-qoder.attachments')
  })
  ctx.llm.registerAdapter([QODER_PROVIDER, QODER_BYOK_PROVIDER], adapter)
  // Declare the routes in the configurable-provider directory so selection
  // surfaces (the composer model seat, the Models settings page) render the
  // Qoder groups with their display names instead of anonymous routes.
  ctx.llm.registerConfigurableProviders([
    { provider: QODER_PROVIDER, displayName: 'Qoder CLI', settingsNs: NS, settingsPath: [] },
    { provider: QODER_BYOK_PROVIDER, displayName: 'Qoder 自定义', settingsNs: NS, settingsPath: [] },
  ])
  // registerAdapter's disposer only withdraws the routes; the warm qodercli
  // subprocesses are owned by the adapter and must close with the plugin.
  ctx.effect(() => () => adapter.close(), 'llm-qoder.sessions')
}
