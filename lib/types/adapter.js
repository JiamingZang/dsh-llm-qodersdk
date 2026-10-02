/**
 * `QoderAdapter`: route the harness LLM seam onto a local Qoder CLI account
 * through the qoder-agent-sdk. One warm inner session per host session id
 * carries the conversation (model turns and tool rounds live inside it); host
 * tool schemas are exposed to the inner model through an in-process MCP
 * server whose handlers park until the host delivers tool results on the next
 * request. Side-channel requests (titles, compaction) run cold one-shots.
 * @module dsh-llm-qoder/adapter
 */
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, QODER_MODELS, resolveQoderModelId, } from "./catalog.js";
import { DEFAULT_MODEL_CACHE_TTL_MS, QoderModelCatalog } from "./models.js";
import { feedImageRefs, feedToText, imageRefs, joinFeeds, renderInitialFeed, renderRefreshed, renderUserTurn } from "./render.js";
import { QoderSessionManager } from "./session.js";
/** The primary provider route (the qoder account's built-in models). */
export const QODER_PROVIDER = 'qoder';
/** Secondary route advertising only the account's custom models. */
export const QODER_BYOK_PROVIDER = 'qoder-byok';
function modelInfo(provider, entry) {
    return {
        provider,
        id: entry.id,
        name: entry.name,
        ...entry.description === undefined ? {} : { description: entry.description },
        inputModalities: entry.isVl === true ? ['text', 'image'] : ['text'],
    };
}
/**
 * Default selectable reasoning efforts for a Qoder model. The CLI catalog
 * reports per-model `efforts`; this is the fallback when a model (or the
 * static catalog) discloses none.
 */
const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'];
/** Human display name for the default effort ids. */
const EFFORT_NAMES = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    max: 'Max',
};
/**
 * Build the `reasoning` metadata block for a resolved model, or undefined
 * when the model does not support reasoning.
 * @param efforts - CLI-reported effort ids (absent for reasoning-less models).
 * @param defaultEffort - CLI-reported default effort id.
 * @param isReasoning - whether the model supports reasoning per the CLI.
 * @returns the harness reasoning metadata, or undefined to omit it.
 */
export function reasoningInfo(efforts, defaultEffort, isReasoning) {
    if (efforts === undefined && isReasoning === false)
        return undefined;
    const ids = efforts !== undefined && efforts.length > 0
        ? efforts
        : DEFAULT_REASONING_EFFORTS;
    return {
        efforts: ids.map(id => ({
            id: ReasoningEffortId(id),
            name: EFFORT_NAMES[id] ?? id,
        })),
        ...defaultEffort !== undefined && ids.includes(defaultEffort)
            ? { defaultEffort: ReasoningEffortId(defaultEffort) }
            : {},
    };
}
/**
 * The Qoder-backed adapter. Session continuity, tool parking, and feed
 * planning live here; chunk synthesis lives in the session's consumer.
 */
export class QoderAdapter extends LlmAdapter {
    sessions;
    catalog;
    readImage;
    constructor(options = {}) {
        super();
        this.sessions = new QoderSessionManager(options.maxSessions ?? 8);
        this.catalog = new QoderModelCatalog(options.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS);
        this.readImage = options.readImage;
    }
    providerInfo(provider) {
        return {
            id: provider,
            name: provider === QODER_BYOK_PROVIDER ? 'Qoder 自定义' : 'Qoder CLI',
        };
    }
    async listModels(provider) {
        const cliModels = await this.catalog.models();
        if (provider === QODER_BYOK_PROVIDER) {
            // Only the account's custom models, which have their own route.
            return cliModels
                .filter(entry => entry.source === 'user' || entry.source === 'custom')
                .map(entry => modelInfo(provider, entry));
        }
        // The built-in route lists the qoder account's own models, excluding the
        // custom models that have their own route.
        return cliModels
            .filter(entry => entry.source !== 'user' && entry.source !== 'custom')
            .map(entry => modelInfo(provider, entry));
    }
    async resolveModel(provider, model, _signal) {
        // The host may address a model by a `deepseek-v4-*` alias or a `qoder-`
        // prefixed id, while the CLI catalog is keyed by the SDK value. Resolve the
        // address to find the metadata, but echo the requested id back: the seam
        // rejects an exact-model result whose id differs from the one asked for.
        const target = resolveQoderModelId(model);
        const live = (await this.catalog.liveModels()).find(entry => entry.value === target);
        if (live !== undefined) {
            const reasoning = reasoningInfo(live.efforts, live.defaultEffort, live.isReasoning);
            return {
                provider,
                id: model,
                name: live.displayName.length > 0 ? live.displayName : live.value,
                ...live.description.length > 0 ? { description: live.description } : {},
                // Only an affirmative CLI `isVl` declares image input. The harness
                // projects images to handle text for a route that omits it, so a claim
                // the CLI did not make would silently drop pixels; the reverse error
                // would send pixels to a model that cannot read them.
                inputModalities: live.isVl === true ? ['text', 'image'] : ['text'],
                context: {
                    // The compaction engine and context meter price against the window
                    // a request actually uses. qodercli reports maxInputTokens as the
                    // model's CEILING (often 1M) while defaultContextWindow is the
                    // effective per-session window (e.g. 200K); using the ceiling would
                    // push the auto-compaction threshold far past what the provider
                    // accepts, and past what the inner session actually runs with.
                    contextWindow: live.defaultContextWindow ?? live.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
                },
                defaultMaxTokens: live.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
                ...reasoning === undefined ? {} : { reasoning },
            };
        }
        const configured = QODER_MODELS.find(entry => entry.id === target);
        const reasoning = reasoningInfo(undefined, undefined, true);
        return Promise.resolve({
            ...configured === undefined
                ? { provider, id: model, name: model, inputModalities: ['text'] }
                : { ...modelInfo(provider, configured), id: model },
            context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
            defaultMaxTokens: DEFAULT_MAX_TOKENS,
            ...reasoning === undefined ? {} : { reasoning },
        });
    }
    /**
     * Bind one resolution generation to its dispatch, as the seam requires of a
     * dynamic adapter: the live catalog and the CLI login can change between the
     * harness preparing a call and the inner session running it, and a turn must
     * not mix one generation's declared capabilities with another's endpoint.
     */
    async prepareCall(provider, model, signal) {
        const generation = await this.capture(provider, model, signal);
        return {
            model: generation.info,
            stream: options => this.dispatch(options, generation),
        };
    }
    async *stream(options) {
        yield* this.dispatch(options, await this.capture(options.provider, options.model, options.signal));
    }
    /** Resolve the exact route once and derive the capability facts from it. */
    async capture(provider, model, signal) {
        const info = await this.resolveModel(provider, model, signal);
        return { info, vision: info.inputModalities?.includes('image') === true };
    }
    async *dispatch(options, generation) {
        const model = resolveQoderModelId(options.model);
        if (options.sessionId === undefined || options.purpose !== undefined) {
            // Side channels summarise text; pixels would only cost them context.
            const prompt = feedToText(renderInitialFeed(options.system, options.messages))
                + '\n（这是一次性旁路请求，直接输出下一条助手回复。）';
            // Side channels (titles, compaction summaries) reuse the main session's
            // model so dsh's recorded summarization target matches what qodercli
            // actually runs — a different default route could have different
            // context limits or quota, silently failing the compaction.
            yield* this.sessions.coldStream(options, prompt, model);
            return;
        }
        const sessionId = String(options.sessionId);
        // The seam carries no per-request context window: the route's capacity
        // comes from resolveModel, and the inner session uses the CLI's own window.
        const policy = {
            ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
        };
        let session = this.sessions.forSession(sessionId, model);
        if (session.fedMessages === undefined) {
            yield* this.firstTurn(session, options, model, policy, generation.vision);
            return;
        }
        const tail = options.messages.slice(session.fedMessages.length);
        const images = await this.resolveTurnImages(tail, generation.vision, options.signal);
        session.deliverToolResults(tail, images);
        const plan = planContinuation(session.fedMessages, options.messages);
        if (plan.rebuild) {
            this.sessions.dispose(sessionId);
            session = this.sessions.forSession(sessionId, model);
            yield* this.firstTurn(session, options, model, policy, generation.vision);
            return;
        }
        session.setModel(model, policy);
        session.ensureTools(options.tools ?? []);
        session.recordRequestInput(options.system, options.messages);
        session.fedMessages = options.messages;
        session.fedSystem = options.system;
        yield* session.stream(options, plan.feed === null ? null : await this.buildFeed(plan.feed, generation.vision, images));
    }
    async *firstTurn(session, options, model, policy, vision) {
        session.setModel(model, policy);
        session.setSystem(options.system);
        // Older dsh-llm releases lack the cwd field on GenerateOptions; read it
        // through the widened view so this adapter compiles against the peer range.
        const cwd = options.cwd;
        session.setCwd(cwd);
        session.ensureTools(options.tools ?? []);
        session.recordRequestInput(options.system, options.messages);
        session.fedMessages = options.messages;
        session.fedSystem = options.system;
        const feed = renderInitialFeed(options.system, options.messages);
        const images = await this.resolveImages(feedImageRefs(feed), vision, options.signal);
        yield* session.stream(options, await this.buildFeed(feed, vision, images));
    }
    /** Image references carried by a message tail, skipping assistant content. */
    async resolveTurnImages(tail, vision, signal) {
        const refs = tail.flatMap(message => message.role === 'assistant' ? [] : imageRefs(message.content));
        return this.resolveImages(refs, vision, signal);
    }
    /** Resolve image references into base64 request bytes; absent reader → none. */
    async resolveImages(refs, vision, signal) {
        const map = new Map();
        if (!vision || this.readImage === undefined || refs.length === 0)
            return map;
        for (const ref of refs) {
            const key = String(ref.attachmentId);
            if (map.has(key))
                continue;
            try {
                const image = await this.readImage(ref, signal);
                if (image !== undefined) {
                    map.set(key, { data: Buffer.from(image.bytes).toString('base64'), mediaType: image.mediaType });
                }
            }
            catch {
                // One unreadable attachment degrades to handle text; the turn continues.
            }
        }
        return map;
    }
    /**
     * Turn a feed into channel content. A text feed passes through; a non-vision
     * feed flattens to the harness's own image handle text; an image the host
     * could not read keeps a note naming what was dropped, so the inner model
     * still knows the attachment was there.
     */
    async buildFeed(feed, vision, images) {
        if (typeof feed === 'string')
            return feed;
        if (!vision)
            return feedToText(feed);
        const content = [];
        let pixels = 0;
        for (const part of feed) {
            if (part.type === 'text') {
                if (part.text.length > 0)
                    content.push({ type: 'text', text: part.text });
                continue;
            }
            const resolved = images.get(String(part.attachment.attachmentId));
            if (resolved === undefined) {
                content.push({ type: 'text', text: `[图片附件 ${String(part.attachment.attachmentId)} 本次未能读取，请基于文字内容继续]` });
                continue;
            }
            pixels += 1;
            content.push({
                type: 'image',
                source: { type: 'base64', media_type: resolved.mediaType, data: resolved.data },
            });
        }
        // Nothing to show as pixels: stay in the historical single-string shape.
        return pixels === 0 ? content.map(block => block.type === 'text' ? block.text : '').join('\n\n') : content;
    }
    /** Tear down every warm inner session (plugin dispose). */
    close() {
        this.sessions.closeAll();
    }
}
/**
 * Decide what to feed on a continuation request. The previous list must be a
 * prefix (same length growth, index 0 untouched, at most two in-place
 * mutations — the host refreshes runtime-context snapshots in place every
 * turn). Tail tool-result messages were already resolved into parked handlers
 * and never feed; fresh user turns and mutated messages do.
 */
export function planContinuation(previous, current) {
    if (current.length <= previous.length)
        return { feed: null, rebuild: true };
    const mutated = [];
    for (let i = 0; i < previous.length; i++) {
        if (JSON.stringify(previous[i]) !== JSON.stringify(current[i]))
            mutated.push(i);
    }
    if (mutated.includes(0) || mutated.length > 2)
        return { feed: null, rebuild: true };
    const tail = current.slice(previous.length);
    const freshUser = tail.filter(m => m.role === 'user');
    if (freshUser.length === 0 && mutated.length === 0)
        return { feed: null, rebuild: false };
    const parts = [];
    for (const index of mutated) {
        const message = current[index];
        if (message !== undefined)
            parts.push(renderRefreshed(message));
    }
    for (const message of freshUser)
        parts.push(renderUserTurn(message.content));
    const feed = joinFeeds(parts);
    return { feed: typeof feed === 'string' && feed.length === 0 ? null : feed, rebuild: false };
}
//# sourceMappingURL=adapter.js.map