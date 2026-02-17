/**
 * 拼接URL和查询参数，会自动处理转义
 * @param url 基础URL，不要带任何查询参数
 * @param queryParams 查询参数对象，键值对形式，值可以是字符串或数字，但是目前不建议出现同key的对象
 * @returns 
 */
export function joinUrlWithParams(url: string, queryParams: Record<string, string | number | boolean>): string {
    if (Object.keys(queryParams).length === 0) {
        return url;
    }

    const params = new URLSearchParams();
    Object.entries(queryParams).forEach(([key, value]) => {
        if (typeof value === 'string') {
            params.append(key, value);
        } else {
            params.append(key, value.toString());
        }
    });

    return `${url}?${params.toString()}`;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';

// 默认超时时间，单位毫秒
const DEFAULT_TIMEOUT = 5000;

/**
 * 发起一个带有默认配置的 HTTP 请求
 * 默认不处理异常，需要try catch
 * @param url 请求的URL，不要拼接查询参数，但是要提供path params
 * @param method HTTP方法，默认为GET
 * @param queryParams 查询参数，会被自动拼接到url中（会自动进行转义）
 * @param customHeaders 自定义请求头，不需要写content-type这种会被自动处理的头
 * @param body 请求体，适用于POST/PUT请求，传入字符串、数字会被处理成text/plain，传入对象会被处理成application/json，传入FormData会被处理成multipart/form-data，目前不建议直接发送二进制对象
 * @returns 返回Fetch API的Response对象
 */
export async function makeHttpRequest(
    url: string,
    method: HttpMethod = 'GET',
    queryParams: Record<string, string | number> | null = null,
    customHeaders: Record<string, string> | null = null,
    body: any | null = null,
    timeoutMs: number = DEFAULT_TIMEOUT
): Promise<Response> {
    // 处理查询参数
    if (queryParams != null) {
        url = joinUrlWithParams(url, queryParams);
    }

    // 处理header设定，主要是处理Content-Type
    if (customHeaders == null) {
        customHeaders = {};
    }

    if (body == null) {
        // 无body时，不设置Content-Type
    } else if (body instanceof FormData) {
        // 使用FormData时，浏览器会自动设置Content-Type和boundary，不要多手
    } else if (typeof body === 'string') {
        customHeaders['Content-Type'] = 'text/plain';
    } else if (typeof body === 'number') {
        customHeaders['Content-Type'] = 'text/plain';
        body = body.toString();
    } else if (typeof body === 'object') {
        customHeaders['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
    }

    // 配置超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch(url, {
        method: method,
        headers: customHeaders,
        body: body,
        signal: controller.signal,
    });
    clearTimeout(timeoutId);

    return resp;
}

/**
 * 发起一个SSE请求，返回一个异步生成器，每次迭代返回一个字符串（流式响应）
 * 这个方法是拿来补充浏览器里面的EventSource的，扩展了很多没有的功能，跟原版的SSE协议不完全兼容。
 * 目前这个接口只支持处理后端不停发送data: xxx\n\n这种格式的响应
 * 默认不抛出异常，会在生成器的返回值里面指明成功还是失败
 * @see makeHttpRequest 这里的参数说明
 * @returns 返回一个异步生成器，每次迭代返回一个字符串（流式响应）
 */
export async function* makeSSERequest(
    url: string,
    method: HttpMethod = 'GET',
    queryParams: Record<string, string | number> | null = null,
    customHeaders: Record<string, string> | null = null,
    body: any | null = null
): AsyncGenerator<string, boolean, undefined> {
    const resp = await makeHttpRequest(url, method, queryParams, customHeaders, body, 30000);
    if (!resp.ok) {
        return false;
    }

    const reader = resp.body?.getReader();
    if (reader == null) {
        return false;
    }
    let buffer = new Uint8Array(0)

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done || !value) {
                break;
            }

            // 拼接之前的残留数据
            let tempBuffer = new Uint8Array(buffer.length + value.length);
            tempBuffer.set(buffer, 0);
            tempBuffer.set(value, buffer.length);
            buffer = tempBuffer;

            if (buffer.length < 8) {
                // 每行数据至少都有'data: \n\n'，不够8个字节一定是不完整的
                continue;
            }

            // 拿出每一行数据出来
            let lineEndIndex = extractSSELine(buffer);
            while (lineEndIndex != null) {
                // 截取出来然后解析
                let line = buffer.slice(0, lineEndIndex + 1);
                let lineStr = new TextDecoder('utf-8').decode(line);
                // 切掉开头和结尾的东西
                yield lineStr.slice(5, lineStr.length - 2);

                if (lineEndIndex == buffer.length - 1) {
                    // 这个时候不能去切了，直接返回空数组可能效率更高
                    buffer = new Uint8Array(0);
                    lineEndIndex = null;
                } else {
                    buffer = buffer.subarray(lineEndIndex + 1);
                    lineEndIndex = extractSSELine(buffer);
                }
            }
        }

        // 处理掉剩余部份
        if (buffer.length > 0) {
            let lastLineEndIndex = extractSSELine(buffer);

            while (lastLineEndIndex != null) {
                let line = buffer.slice(0, lastLineEndIndex + 1);
                let lineStr = new TextDecoder('utf-8').decode(line);
                yield lineStr.slice(5, lineStr.length - 2);

                buffer = buffer.subarray(lastLineEndIndex + 1);
                lastLineEndIndex = extractSSELine(buffer);
            }

            if (buffer.length > 0) {
                // 有问题，数据不完整
                throw new Error('SSE data is not complete');
            }
        }
    } catch (error) {
        console.error('SSE error:', error);
        return false;
    } finally {
        reader.releaseLock();
    }

    return true;
}

/**
 * 解析SSE响应中的一行数据
 * @param buffer 需要处理的数组（只读，该函数不会修改它）
 * @returns 返回解析到的一行数据的结束索引，如果没有完整的一行数据，返回null。这个值指向最后一个\n的位置，slice的时候注意坐标运算
 */
function extractSSELine(buffer: Uint8Array): number | null {
    if (buffer.length < 8) {
        // 每行数据至少都有'data: \n\n'，不够8个字节一定是不完整的
        return null;
    }

    // 判断开头的6个字节是否是'data: '
    if (
        buffer[0] !== 0x64 ||
        buffer[1] !== 0x61 ||
        buffer[2] !== 0x74 ||
        buffer[3] !== 0x61 ||
        buffer[4] !== 0x3A ||
        buffer[5] !== 0x20
    ) {
        // 不是的话就有问题了
        throw new Error('SSE data is not valid');
    }

    // 查找\n\n的位置
    for (let i = 0; i < buffer.length - 1; ++i) {
        if (buffer[i] === 0x0A && buffer[i + 1] === 0x0A) {
            return i + 1;
        }
    }

    // 没有找到\n\n，返回null
    return null;
}