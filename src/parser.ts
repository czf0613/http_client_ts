/** 默认限制单个 SSE 事件各行内容的 UTF-8 字节总量，不含换行符。 */
export const DEFAULT_MAX_EVENT_BYTES = 8 * 1024 * 1024;

export function validateEventLimit(maxEventBytes: number): void {
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) {
        throw new RangeError('maxEventBytes must be a positive safe integer');
    }
}

/** 增量解析 SSE data 字段；其他字段和注释不产生字符串事件。 */
export class SSEParser {
    private line: Uint8Array<ArrayBuffer>;
    private lineLength = 0;
    private eventBytes = 0;
    private data: string[] = [];
    private firstLine = true;
    private skipLF = false;
    private readonly decoder = new TextDecoder('utf-8', { ignoreBOM: true });

    constructor(private readonly maxEventBytes: number) {
        validateEventLimit(maxEventBytes);
        this.line = new Uint8Array(Math.min(1024, maxEventBytes));
    }

    private append(bytes: Uint8Array): void {
        const length = this.lineLength + bytes.length;
        if (length > this.line.length) {
            const grown = new Uint8Array(Math.min(this.maxEventBytes, Math.max(length, this.line.length * 2)));
            grown.set(this.line.subarray(0, this.lineLength));
            this.line = grown;
        }
        this.line.set(bytes, this.lineLength);
        this.lineLength = length;
    }

    private processLine(): string | undefined {
        let line = this.decoder.decode(this.line.subarray(0, this.lineLength));
        this.lineLength = 0;
        if (this.firstLine) {
            this.firstLine = false;
            if (line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
        }
        if (line === '') {
            const message = this.data.length > 0 ? this.data.join('\n') : undefined;
            this.data = [];
            this.eventBytes = 0;
            return message;
        }
        if (line[0] === ':') return;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        if (field === 'data') {
            let value = colon < 0 ? '' : line.slice(colon + 1);
            if (value[0] === ' ') value = value.slice(1);
            this.data.push(value);
        }
    }

    *feed(chunk: Uint8Array): Generator<string> {
        let start = 0;
        for (let i = 0; i < chunk.length; i++) {
            const byte = chunk[i];
            if (this.skipLF) {
                this.skipLF = false;
                if (byte === 0x0A) {
                    start = i + 1;
                    continue;
                }
            }
            if (byte !== 0x0A && byte !== 0x0D) {
                if (++this.eventBytes > this.maxEventBytes) {
                    throw new RangeError(`SSE event exceeds maxEventBytes (${this.maxEventBytes})`);
                }
                continue;
            }
            this.append(chunk.subarray(start, i));
            this.skipLF = byte === 0x0D;
            start = i + 1;
            const message = this.processLine();
            if (message !== undefined) yield message;
        }
        this.append(chunk.subarray(start));
    }
    // EOF 不补发尚未被空行终止的事件，遵循 SSE 的结束规则。
}
