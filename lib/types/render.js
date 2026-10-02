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
import { fileHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm';
/** Image references in block order. */
export function imageRefs(blocks) {
    const refs = [];
    for (const block of blocks) {
        if (block.type === 'image')
            refs.push(block.attachment);
    }
    return refs;
}
/** Render one content-block list as plain text; non-text blocks get handles. */
export function renderBlocks(blocks) {
    const parts = [];
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
                parts.push(block.text);
                break;
            case 'reasoning': break;
            case 'image':
                parts.push(textOnlyImageText(block.attachment));
                break;
            case 'file':
                parts.push(fileHandleText(block.attachment, undefined));
                break;
            case 'tool-call':
                parts.push(`[调用了工具 ${block.name}(${block.arguments})]`);
                break;
            case 'tool-addition':
                parts.push(`[工具启用 ${block.toolName}]`);
                break;
            case 'tool-removal':
                parts.push(`[工具停用 ${block.toolName}]`);
                break;
            default: parts.push(JSON.stringify(block));
        }
    }
    return parts.join('\n');
}
/** Role tag {@link renderMessage} uses, without the rendered content. */
function roleTag(message) {
    switch (message.role) {
        case 'system': return '系统提示';
        case 'developer': return '开发者';
        case 'user': return '用户';
        case 'assistant': return '助手';
        case 'tool': return '工具结果';
    }
}
/**
 * Render one request message with its role tag. A request-only user input has
 * no durable identity or source, so it reads exactly like a user message.
 */
export function renderMessage(message) {
    return `[${roleTag(message)}] ${renderBlocks(message.content)}`;
}
/** Preamble establishing the inner model's role as this agent's LLM backend. */
const BACKEND_ROLE = [
    '你在为一个编码 agent（宿主）充当 LLM API 后端：宿主把它的对话喂给你，你只输出"下一条助手回复"本身。',
    '宿主的工具已经通过 MCP 挂进来，需要用工具时直接调用，不要描述你会在别的环境里怎么调。',
    '不要复述对话，不要解释你的角色。',
].join('\n');
/**
 * Join feed sections into one feed. While no section carries an image the
 * result is the historical text shape, sections separated by a blank line;
 * the first image turns the whole feed into parts, with the text around it
 * merged into the parts before and after.
 */
export function joinFeeds(sections) {
    const parts = [];
    const push = (part) => {
        if (part.type === 'text' && part.text.length === 0)
            return;
        const previous = parts.at(-1);
        if (previous !== undefined && previous.type === 'text' && part.type === 'text') {
            previous.text = `${previous.text}\n\n${part.text}`;
            return;
        }
        parts.push(part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image', attachment: part.attachment });
    };
    for (const section of sections) {
        if (typeof section === 'string')
            push({ type: 'text', text: section });
        else
            for (const part of section)
                push(part);
    }
    const images = parts.filter(part => part.type === 'image');
    if (images.length > 0)
        return parts;
    return parts.map(part => part.type === 'text' ? part.text : '').join('\n\n');
}
/** Render a block list as parts, keeping image occurrences as their references. */
export function blockParts(blocks) {
    const parts = [];
    let pending = [];
    const flush = () => {
        if (pending.length === 0)
            return;
        parts.push({ type: 'text', text: pending.join('\n') });
        pending = [];
    };
    for (const block of blocks) {
        if (block.type === 'image') {
            flush();
            parts.push({ type: 'image', attachment: block.attachment });
            continue;
        }
        const text = renderBlocks([block]);
        if (text.length > 0)
            pending.push(text);
    }
    flush();
    return parts;
}
/** Prefix a label onto a feed, folding it into the leading text when there is any. */
function label(labelText, feed) {
    if (typeof feed === 'string')
        return labelText + feed;
    const first = feed[0];
    if (first === undefined)
        return [{ type: 'text', text: labelText }];
    if (first.type === 'text')
        return [{ type: 'text', text: `${labelText}${first.text}` }, ...feed.slice(1)];
    return [{ type: 'text', text: labelText }, ...feed];
}
/**
 * Index where the message list's current turn starts: everything after the
 * last assistant reply is new content the inner session has not seen, so its
 * images are worth forwarding as bytes.
 */
export function currentTurnStart(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant')
            return i + 1;
    }
    return 0;
}
/** Image references carried by a feed, in order. */
export function feedImageRefs(feed) {
    if (typeof feed === 'string')
        return [];
    return feed.filter(part => part.type === 'image').map(part => part.attachment);
}
/** Flatten a feed back to text, replacing images with the harness handle text. */
export function feedToText(feed) {
    if (typeof feed === 'string')
        return feed;
    return feed
        .map(part => part.type === 'text' ? part.text : textOnlyImageText(part.attachment))
        .filter(text => text.length > 0)
        .join('\n\n');
}
/**
 * Characters a feed is charged at for context accounting: literal text plus
 * {@link imageChars} for every image, because the inner CLI reports no usage
 * for the pixels it consumes.
 */
export function feedLength(feed, imageChars) {
    if (typeof feed === 'string')
        return feed.length;
    return feed.reduce((total, part) => total + (part.type === 'text' ? part.text.length : imageChars), 0);
}
/**
 * Compose the first feed for a fresh session: backend role, the host system
 * prompt, and the existing conversation as compact context. Messages of the
 * current turn keep their image references; earlier ones are handles.
 */
export function renderInitialFeed(system, messages) {
    const from = currentTurnStart(messages);
    const history = [];
    for (const [index, message] of messages.entries()) {
        const entry = index >= from && imageRefs(message.content).length > 0
            ? label(`[${roleTag(message)}] `, blockParts(message.content))
            : renderMessage(message);
        if (feedToText(entry).length > 0)
            history.push(entry);
    }
    const sections = [BACKEND_ROLE];
    if (system !== undefined && system.length > 0) {
        sections.push(`---- 宿主系统提示（作为你的行为准则） ----\n${system}`);
    }
    const first = history[0];
    if (first !== undefined) {
        sections.push(label('---- 宿主对话记录 ----\n', first));
        sections.push(...history.slice(1));
    }
    sections.push('---- 以上是背景。输出下一条助手回复。 ----');
    return joinFeeds(sections);
}
/** Render a brand-new host user turn; images stay references, text-only stays a string. */
export function renderUserTurn(blocks) {
    if (imageRefs(blocks).length === 0)
        return `[用户] ${renderBlocks(blocks)}`;
    return label('[用户] ', blockParts(blocks));
}
/** Render an in-place-updated message (runtime-context snapshots and the like). */
export function renderRefreshed(message) {
    return `${renderMessage(message)}\n（宿主原位刷新了这条消息）`;
}
/** Render a host system-prompt update mid-session. */
export function renderSystemUpdate(system) {
    return `[系统提示(更新)] ${system}`;
}
/**
 * Identity override appended to the qodercli preset system prompt: the inner
 * model answers as the host's agent, never as Qoder itself.
 */
export function renderIdentityAppend(hostSystem) {
    const parts = [
        '你当前作为一个宿主编码 agent 的内置 LLM 后端运行：对外身份以宿主的设定为准。',
        '当被问及“你是谁”这类身份问题时，按宿主系统提示中的身份回答；不要自称 Qoder，不要提及 qodercli、SDK 或你作为内部后端的事实。',
    ];
    if (hostSystem !== undefined && hostSystem.length > 0) {
        parts.push(`---- 宿主系统提示（作为你的行为准则与对外身份） ----\n${hostSystem}`);
    }
    return parts.join('\n\n');
}
//# sourceMappingURL=render.js.map