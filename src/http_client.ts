import { DEFAULT_TIMEOUT, validateTimeout, withTimeout } from './timer.js';
import { ExtendedResponse } from './response_ext.js';
import { DEFAULT_MAX_EVENT_BYTES, SSEParser, validateEventLimit } from './parser.js';

type QueryParams = Record<string, string | number | boolean>;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/** 合并查询参数；同名键由新值覆盖，保留 fragment，支持相对 URL。 */
export function joinUrlWithParams(url: string, queryParams: QueryParams): string {
    const entries = Object.entries(queryParams);
    if (entries.length === 0) return url;
    const hashIndex = url.indexOf('#');
    const fragment = hashIndex < 0 ? '' : url.slice(hashIndex);
    const base = hashIndex < 0 ? url : url.slice(0, hashIndex);
    const queryIndex = base.indexOf('?');
    const path = queryIndex < 0 ? base : base.slice(0, queryIndex);
    const params = new URLSearchParams(queryIndex < 0 ? '' : base.slice(queryIndex + 1));
    for (const [key, value] of entries) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
            throw new TypeError(`Query parameter ${key} must be a string, number or boolean`);
        }
        params.set(key, String(value));
    }
    return `${path}?${params.toString()}${fragment}`;
}

function prepareBody(body: unknown, headers: Headers): BodyInit | null {
    if (body == null) return null;
    if (typeof body === 'string' || typeof body === 'number') {
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/plain');
        return String(body);
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
        headers.delete('Content-Type');
        return body;
    }
    if ((typeof Blob !== 'undefined' && body instanceof Blob)
        || (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
        || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        return body as BodyInit;
    }
    if (typeof body === 'object'
        && (Array.isArray(body) || Object.getPrototypeOf(body) === Object.prototype || Object.getPrototypeOf(body) === null)) {
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        const json = JSON.stringify(body);
        if (json !== undefined) return json;
    }
    throw new TypeError('Unsupported request body; use text, a number, JSON objects/arrays, FormData, Blob, URLSearchParams or binary buffers');
}

/**
 * 发起 HTTP 请求。非 OK 状态仍返回响应，网络错误、超时及取消向外传播。
 * @param timeoutMs 从 fetch 开始到收到响应头的期限，默认 5000 ms；0 关闭。
 * 响应体需要独立使用 jsonWithTimeout/textWithTimeout 等方法控制读取期限。
 * @param signal 可选的外部取消信号，对等待响应头和响应体读取均有效。
 */
export async function makeHttpRequest(
    url: string,
    method: HttpMethod = 'GET',
    queryParams: QueryParams | null = null,
    customHeaders: Record<string, string> | null = null,
    body: any | null = null,
    timeoutMs: number = DEFAULT_TIMEOUT,
    signal?: AbortSignal,
): Promise<ExtendedResponse> {
    validateTimeout(timeoutMs);
    if (signal?.aborted) throw signal.reason;
    if (queryParams != null) url = joinUrlWithParams(url, queryParams);
    const headers = new Headers(customHeaders ?? {});
    const requestBody = prepareBody(body, headers);
    const controller = new AbortController();
    const abort = () => controller.abort(signal!.reason);
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    // headers getter 或 JSON.toJSON 也可能在准备参数时触发取消。
    if (signal?.aborted) abort();

    try {
        const response = await withTimeout(async () => {
            const response = await fetch(url, { method, headers, body: requestBody, signal: controller.signal });
            if (controller.signal.aborted) {
                void response.body?.cancel(controller.signal.reason).catch(() => {});
                throw controller.signal.reason;
            }
            return response;
        }, timeoutMs, `Request timeout after ${timeoutMs}ms`, controller.signal, reason => controller.abort(reason));
        return ExtendedResponse.create(response, controller.signal, cleanup);
    } catch (error) {
        cleanup();
        throw error;
    }
}

/**
 * 读取标准 SSE 的 data 字段，支持 for await；失败抛出异常，正常结束返回 true。
 * @param connectTimeoutMs 响应头等待期限，默认 30000 ms；0 关闭。
 * @param messageTimeoutMs 每次 reader.read() 的期限，默认 30000 ms；0 关闭。
 * @param signal 外部取消信号，可中断等待中的读取。
 * @param maxEventBytes 单个事件各行内容的字节上限，不含换行；默认 8 MiB。
 * 支持 LF/CRLF/CR、BOM、注释和多行 data；EOF 丢弃未被空行终止的事件。
 */
export async function* makeSSERequest(
    url: string,
    method: HttpMethod = 'GET',
    queryParams: QueryParams | null = null,
    customHeaders: Record<string, string> | null = null,
    body: any | null = null,
    connectTimeoutMs: number = 30000,
    messageTimeoutMs: number = 30000,
    signal?: AbortSignal,
    maxEventBytes: number = DEFAULT_MAX_EVENT_BYTES,
): AsyncGenerator<string, boolean, undefined> {
    validateTimeout(connectTimeoutMs, 'connectTimeoutMs');
    validateTimeout(messageTimeoutMs, 'messageTimeoutMs');
    validateEventLimit(maxEventBytes);
    const headers = { ...customHeaders };
    if (!Object.keys(headers).some(key => key.toLowerCase() === 'accept')) headers.Accept = 'text/event-stream';
    let response: ExtendedResponse | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    let completed = false;
    let failure: unknown;

    try {
        response = await makeHttpRequest(url, method, queryParams, headers, body, connectTimeoutMs, signal);
        if (!response.ok) {
            throw Object.assign(new Error(`SSE request failed with HTTP ${response.status} ${response.statusText}`.trim()), {
                name: 'HTTPError', status: response.status, statusText: response.statusText,
            });
        }
        if (response.body === null) throw new Error('SSE response has no body');
        reader = response.body.getReader();
        const parser = new SSEParser(maxEventBytes);
        while (true) {
            const result = await withTimeout(
                () => reader!.read(), messageTimeoutMs,
                `SSE read timeout after ${messageTimeoutMs}ms`, signal,
            );
            if (result.done) {
                completed = true;
                return true;
            }
            for (const message of parser.feed(result.value)) {
                if (signal?.aborted) throw signal.reason;
                yield message;
            }
        }
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        if (reader !== undefined) {
            if (!completed) void reader.cancel(failure).catch(() => {});
            reader.releaseLock();
        } else if (response?.body !== null && response?.body !== undefined) {
            void response.body.cancel(failure).catch(() => {});
        }
    }
}
