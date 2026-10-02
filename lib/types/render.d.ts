/**
 * Render harness messages into the turns fed to the inner Qoder session.
 * Tool calls and results need no protocol here — they travel through the
 * in-process MCP server — so this layer handles conversational context: the
 * host system prompt, user turns, and (for full rebuilds) prior history as
 * compact text.
 *
 * A feed is plain text unless the *current* turn carries image occurrences,
 * in which case it is a part list so those bytes can ride along. Historical
 * images stay text: the harness has already replaced them with its own
 * placeholder for text-only routes, and re-sending archived pixels on every
 * rebuild would price a screenshot into every later request.
 * @module dsh-llm-qoder/render
 */
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
/** One element of a feed: literal text, or an image awaiting byte resolution. */
export type FeedPart = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    attachment: ImageAttachmentRef;
};
/** What one inner turn receives: text (the historical shape) or text + images. */
export type Feed = string | FeedPart[];
/** Image references in block order. */
export declare function imageRefs(blocks: readonly ContentBlock[]): ImageAttachmentRef[];
/** Render one content-block list as plain text; non-text blocks get handles. */
export declare function renderBlocks(blocks: readonly ContentBlock[]): string;
/**
 * Render one request message with its role tag. A request-only user input has
 * no durable identity or source, so it reads exactly like a user message.
 */
export declare function renderMessage(message: RequestMessage): string;
/**
 * Join feed sections into one feed. While no section carries an image the
 * result is the historical text shape, sections separated by a blank line;
 * the first image turns the whole feed into parts, with the text around it
 * merged into the parts before and after.
 */
export declare function joinFeeds(sections: readonly Feed[]): Feed;
/** Render a block list as parts, keeping image occurrences as their references. */
export declare function blockParts(blocks: readonly ContentBlock[]): FeedPart[];
/**
 * Index where the message list's current turn starts: everything after the
 * last assistant reply is new content the inner session has not seen, so its
 * images are worth forwarding as bytes.
 */
export declare function currentTurnStart(messages: readonly RequestMessage[]): number;
/** Image references carried by a feed, in order. */
export declare function feedImageRefs(feed: Feed): ImageAttachmentRef[];
/** Flatten a feed back to text, replacing images with the harness handle text. */
export declare function feedToText(feed: Feed): string;
/** Literal characters in a feed; images contribute their pixels, not text. */
export declare function feedTextLength(feed: Feed): number;
/**
 * Compose the first feed for a fresh session: backend role, the host system
 * prompt, and the existing conversation as compact context. Messages of the
 * current turn keep their image references; earlier ones are handles.
 */
export declare function renderInitialFeed(system: string | undefined, messages: readonly RequestMessage[]): Feed;
/** Render a brand-new host user turn; images stay references, text-only stays a string. */
export declare function renderUserTurn(blocks: readonly ContentBlock[]): Feed;
/** Render an in-place-updated message (runtime-context snapshots and the like). */
export declare function renderRefreshed(message: RequestMessage): Feed;
/** Render a host system-prompt update mid-session. */
export declare function renderSystemUpdate(system: string): string;
/**
 * Identity override appended to the qodercli preset system prompt: the inner
 * model answers as the host's agent, never as Qoder itself.
 */
export declare function renderIdentityAppend(hostSystem: string | undefined): string;
//# sourceMappingURL=render.d.ts.map