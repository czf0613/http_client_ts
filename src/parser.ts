/**
 * 解析SSE响应中的一行数据
 * @param buffer 需要处理的数组（只读，该函数不会修改它）
 * @returns 返回解析到的一行数据的结束索引，如果没有完整的一行数据，返回null。这个值指向最后一个\n的位置，slice的时候注意坐标运算
 */
export function extractSSELine(buffer: Uint8Array): number | null {
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