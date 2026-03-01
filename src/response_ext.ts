/**
 * 扩展的Response类，使用Proxy自动代理所有Response属性和方法
 * 用户可以像普通的Response对象一样使用，也可以调用额外的方法
 */
export class ExtendedResponse implements Response {
    // 内部持有的原始Response对象
    private _response: Response;

    // 私有构造函数，通过静态方法创建实例
    private constructor(response: Response) {
        this._response = response;
    }

    // Symbol.toStringTag 用于正确的类型识别
    get [Symbol.toStringTag](): string {
        return 'ExtendedResponse';
    }

    // 静态工厂方法，创建代理后的ExtendedResponse实例
    static create(response: Response): ExtendedResponse {
        const instance = new ExtendedResponse(response);

        // 使用Proxy自动代理所有属性访问
        return new Proxy(instance, {
            get(target, prop) {
                // 如果是ExtendedResponse自定义的属性或方法，优先从target获取
                switch (prop) {
                    case '_response':
                    case 'create':
                    case 'clone':
                        return (target as any)[prop];
                    default:
                        // 否则从原始Response获取
                        const value = (target._response as any)[prop];
                        // 如果是函数，需要绑定this
                        return typeof value === 'function' ? value.bind(target._response) : value;
                }
            }
        });
    }

    // clone方法要特殊处理
    clone(): ExtendedResponse {
        return ExtendedResponse.create(this._response.clone());
    }

    // 声明Response接口的所有属性（实际通过Proxy代理访问，这里的都是骗编译器的）
    declare readonly body: ReadableStream<Uint8Array<ArrayBuffer>> | null;
    declare readonly bodyUsed: boolean;
    declare readonly headers: Headers;
    declare readonly ok: boolean;
    declare readonly redirected: boolean;
    declare readonly status: number;
    declare readonly statusText: string;
    declare readonly type: ResponseType;
    declare readonly url: string;

    // Response接口的方法（实际通过Proxy代理到原始Response，这里的方法都也是骗编译器的）
    arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error('Method not implemented.');
    }

    blob(): Promise<Blob> {
        throw new Error('Method not implemented.');
    }

    bytes(): Promise<Uint8Array<ArrayBuffer>> {
        throw new Error('Method not implemented.');
    }

    formData(): Promise<FormData> {
        throw new Error('Method not implemented.');
    }

    json(): Promise<any> {
        throw new Error('Method not implemented.');
    }

    text(): Promise<string> {
        throw new Error('Method not implemented.');
    }
}
