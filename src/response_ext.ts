import { DEFAULT_TIMEOUT, validateTimeout, withTimeout } from './timer.js';
import { manageBody } from './body_stream.js';

type BodyReader = 'json' | 'text' | 'arrayBuffer' | 'blob' | 'bytes';
type Metadata = Pick<Response, 'ok' | 'status' | 'statusText' | 'url' | 'redirected' | 'type'>;

/** 显式委托 Response API，保留元数据及一次性读取行为，不要求原生身份。 */
export class ExtendedResponse implements Response {
    readonly #response: Response;
    readonly #metadata: Metadata;

    private constructor(response: Response, metadata: Metadata) {
        this.#response = response;
        this.#metadata = metadata;
        for (const method of [
            'clone', 'json', 'text', 'arrayBuffer', 'blob', 'bytes', 'formData',
            'jsonWithTimeout', 'textWithTimeout', 'arrayBufferWithTimeout', 'blobWithTimeout', 'bytesWithTimeout',
        ] as const) {
            Object.defineProperty(this, method, {
                value: this[method].bind(this), configurable: true, writable: true,
            });
        }
    }

    /** 内部工厂：外部 signal 在响应体消费/取消前持续有效。 */
    static create(response: Response, signal?: AbortSignal, onFinished: () => void = () => {}): ExtendedResponse {
        const metadata: Metadata = {
            ok: response.ok, status: response.status, statusText: response.statusText,
            url: response.url, redirected: response.redirected, type: response.type,
        };
        if (response.body === null) {
            onFinished();
            return new ExtendedResponse(response, metadata);
        }
        const body = manageBody(response.body, () => {
            signal?.removeEventListener('abort', abort);
            onFinished();
        });
        const abort = () => body.abort(signal!.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        // 此 Response 仅负责 body 和 headers，其他元数据仍来自原始响应。
        return new ExtendedResponse(new Response(body.stream, { headers: response.headers }), metadata);
    }

    get [Symbol.toStringTag](): string { return 'ExtendedResponse'; }
    get body(): ReadableStream<Uint8Array<ArrayBuffer>> | null { return this.#response.body; }
    get bodyUsed(): boolean { return this.#response.bodyUsed; }
    get headers(): Headers { return this.#response.headers; }
    get ok(): boolean { return this.#metadata.ok; }
    get status(): number { return this.#metadata.status; }
    get statusText(): string { return this.#metadata.statusText; }
    get url(): string { return this.#metadata.url; }
    get redirected(): boolean { return this.#metadata.redirected; }
    get type(): ResponseType { return this.#metadata.type; }

    clone(): ExtendedResponse {
        return new ExtendedResponse(this.#response.clone(), this.#metadata);
    }

    json(): Promise<any> { return this.#response.json(); }
    text(): Promise<string> { return this.#response.text(); }
    arrayBuffer(): Promise<ArrayBuffer> { return this.#response.arrayBuffer(); }
    blob(): Promise<Blob> { return this.#response.blob(); }
    bytes(): Promise<Uint8Array<ArrayBuffer>> { return this.#response.bytes(); }
    formData(): Promise<FormData> { return this.#response.formData(); }

    /** 整段响应体读取超时；0 关闭。仅取消当前 body 分支，不终止仍在使用的 clone。 */
    private async readWithTimeout<T>(method: BodyReader, readTimeoutMs: number, label: string): Promise<T> {
        validateTimeout(readTimeoutMs, 'readTimeoutMs');
        const read = this.#response[method] as (() => Promise<T>) | undefined;
        if (typeof read !== 'function') {
            throw new TypeError(`Response.${method}() is not supported by this runtime`);
        }
        if (readTimeoutMs === 0 || this.#response.body === null) {
            return read.call(this.#response);
        }
        if (this.bodyUsed || this.body!.locked) {
            throw new TypeError('Response body is already used or locked');
        }
        // 直接控制 reader，避免原生读取锁住 body 后无法取消；转换仍交给原生方法。
        const body = manageBody(this.body!, undefined, true);
        const response = new Response(body.stream, { headers: this.headers });
        try {
            return await withTimeout(
                () => (response[method] as () => Promise<T>).call(response),
                readTimeoutMs,
                `${label} read timeout after ${readTimeoutMs}ms`,
                undefined,
                reason => body.abort(reason),
            );
        } catch (error) {
            body.abort(error);
            throw error;
        }
    }

    jsonWithTimeout<T>(readTimeoutMs: number = DEFAULT_TIMEOUT): Promise<T> {
        return this.readWithTimeout<T>('json', readTimeoutMs, 'JSON');
    }
    textWithTimeout(readTimeoutMs: number = DEFAULT_TIMEOUT): Promise<string> {
        return this.readWithTimeout('text', readTimeoutMs, 'Text');
    }
    arrayBufferWithTimeout(readTimeoutMs: number = DEFAULT_TIMEOUT): Promise<ArrayBuffer> {
        return this.readWithTimeout('arrayBuffer', readTimeoutMs, 'ArrayBuffer');
    }
    blobWithTimeout(readTimeoutMs: number = DEFAULT_TIMEOUT): Promise<Blob> {
        return this.readWithTimeout('blob', readTimeoutMs, 'Blob');
    }
    bytesWithTimeout(readTimeoutMs: number = DEFAULT_TIMEOUT): Promise<Uint8Array<ArrayBuffer>> {
        return this.readWithTimeout('bytes', readTimeoutMs, 'Bytes');
    }
}
