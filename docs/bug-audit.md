# B01–B15 修复与行为决策记录

审查及修复日期：2026-10-06。问题来自实现基线 `9f1aa58`；下表记录本地工作区已完成的修复及正式回归覆盖，不是待实施提案。本轮没有提交或发布 npm 包。

库仍使用 TypeScript 开发；运行时验收全部改为原生 Node 执行的 JavaScript，消费生成的 JS 和安装后的包入口。最终 `npm test` 包含构建并通过 43 项测试。完整环境和限制见 [维护指南](development.md)，使用方式见 [README](../README.md)。

## 缺陷修复

| 编号 | 原问题 | 已实现的行为 | 回归证据 |
| --- | --- | --- | --- |
| B01 | 无扩展名的相对导入使 Node ESM 报 ERR_MODULE_NOT_FOUND | 源码相对路径带 `.js`，使用 NodeNext 编译和解析；生成的 JS 可直接导入 | 所有 JS 测试导入公共入口；[package.test.js](../tests/package.test.js) 安装 tarball 后按包名导入并读取响应 |
| B02 | TS/tsx 测试绕过实际包入口，且 tsx 未声明 | 删除 TS 测试及旧运行器，使用 node:test 和 JS；无 TS loader | [package.json](../package.json) 的 pretest/test，以及 tests 下五个 JS 测试文件 |
| B03 | 公网 Bing/大型安装包测试不稳定且覆盖不足 | 改为内存流、可控 Fetch 和本地 HTTP 服务；具体断言内容、错误和清理 | [http](../tests/http.test.js)、[response](../tests/response.test.js)、[sse](../tests/sse.test.js)、[integration](../tests/integration.test.js) 测试 |
| B04 | Fetch 拒绝后请求 timer 保留 | 成功、失败、取消和超时都清理 timer/监听器 | http 的三条请求结束路径；package 的子进程自然退出 |
| B05 | 成功读取与 SSE 读取留下竞争 timer | 统一计时封装清理所有完成路径，不累积失效 timer | response 的五种成功读取与异常；sse 的退出/超时；package 的自然退出 |
| B06 | 读超时只拒绝 Promise，底层仍下载且被锁定 | 取消当前读取分支并释放源 reader；有其他 clone 时保留其读取能力 | response 的五种超时、单 clone 隔离及全分支取消；integration 确认下载连接关闭且停止写入 |
| B07 | SSE 提前退出、失败、非 OK 未取消 body | finally 取消不再使用的 body 并释放 reader，非 OK 也清理未读 body | sse 的 break、HTTP 503、流错误、读取超时、超限；integration 的 break/timeout/abort 连接关闭 |
| B08 | SSE payload 多出协议分隔空格 | 仅移除冒号后可选的一个空格，保留业务空白 | sse 的空 data、无空格、多空格、尾部空格和多行内容 |
| B09 | 请求准备修改输入 headers，冻结对象报错 | 复制输入并在副本上准备请求 | http/sse 的冻结输入与复用内容断言 |
| B10 | Content-Type 大小写导致重复头或 FormData 缺 boundary | 用 Headers 做不区分大小写的操作；保留显式类型，FormData 删除副本中所有对应拼写 | http 的自定义 JSON 媒体类型与大写 CONTENT-TYPE FormData；integration 验证实际接收值 |
| B11 | Blob/ArrayBuffer/URLSearchParams 等错误 JSON 化 | 原生表单和二进制类型直接传递；仅普通对象/数组转 JSON；其他顶层类型报错 | http 使用原生 Request 解码 text、JSON、Blob、表单、URLSearchParams、ArrayBuffer 和 view |
| B12 | query/fragment 拼接位置错误 | 合并已有 query，同名键替换，保留其他键与 fragment；支持相对 URL | http 的重复键、已有 query、fragment、编码；integration 的服务端 URL |
| B13 | Proxy 读写与反射不一致，可能违反不变量 | 改为显式委托，保留响应元数据、普通对象属性、稳定绑定方法和扩展 clone | response 的 status/in、自有属性、不可配置属性、clone/headers；integration 的重定向元数据 |
| B14 | boolean 查询值在三个入口类型不一致 | 统一为 Record<string, string \| number \| boolean> 并做运行时类型检查 | http 的辅助函数和 PATCH 查询；sse 复用相同准备路径；生成声明一致 |
| B15 | 不完整事件无上限，每块反复复制/扫描全部残留 | 增量扫描、几何扩容，单事件默认 8 MiB，可配置；超限抛 RangeError 并取消 | sse 的 data/注释/多行超限，以及 256 KiB payload 拆成 32-byte 小块的组装 |

B15 的线性复杂度来自实现结构审查；大事件测试是正确性回归，没有把一次运行耗时当作性能基准。事件上限统计各行的非换行原始字节，包含忽略字段，避免依靠注释绕过限制。

## 八项已确定的行为

### D01：SSE 失败抛异常

`for await` 调用者可用 try/catch 捕获所有失败。非 OK 状态抛出 `name: 'HTTPError'` 并提供 status/statusText；网络和流错误保留原错误；库不打印日志。正常结束仍返回 true，取消了失败 false 的行为。

### D02：补齐常见标准 SSE 格式

支持 LF/CRLF/CR、跨块 UTF-8、初始 BOM、注释心跳、无分隔空格、空 data 和多行 data。只移除协议空格，不 trim 业务内容。输出保持字符串，忽略 event/id/retry/未知字段，不自动重连。[SSE 解析规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)

EOF 遵循标准，丢弃未被空行终止的事件；[DONE] 是普通 payload。默认请求 Accept 为 text/event-stream，保留显式 Accept，不新增响应 MIME 强校验。[SSE EOF 规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)

### D03：messageTimeoutMs 保持逐次读取期限

该参数限制每次 reader.read，不限制组装整条事件。部分数据、注释或心跳到达即可完成该次读取，下一次重新计时；用户处理 yield 内容的时间不计入。0 可关闭，没有额外整事件 deadline。测试使用每 20 ms 一块、50 ms 读取期限，确认约 80 ms 才完整的事件仍可成功。

### D04：AbortSignal 与 clone 的取消范围

不改变旧参数位置，HTTP 第七项、SSE 第八项增加可选 signal。预先中止不会发请求，等待响应头或响应体期间可取消，传播 signal.reason。即使超时关闭，signal 也有效。

读超时取消当前 clone 分支；外部 signal 中止共享输入流。一个 clone 超时不能破坏其他 clone，全部分支取消后才取消根源。等待中的生成器 `.next()` 通过 signal 打断；`.return()` 本身会排在正在进行的读取后。

### D05：PATCH 与请求参数范围

补充 PATCH，不添加 OPTIONS，不扩大为 HeadersInit 或通用 RequestInit。headers 保持普通 string record。显式 Content-Type 优先，FormData 例外由 Fetch 生成 boundary。原生表单/二进制请求体直接传递，未支持的顶层类型明确报错。GET/HEAD body 等仍由 Fetch 规则校验。

### D06：Response 的相似 API 与独立读超时

不要求原生身份、原型或品牌检查兼容。保留 json/text/arrayBuffer/blob/bytes 的对应 WithTimeout 方法、元数据和 clone，普通原生方法不加 timer。HTTP timeout 只到响应头，响应体需要另设读取期限。重建可控 body 时单独保存原响应 metadata，避免丢失 url/redirected/status。

### D07：统一非法值校验和关闭方式

所有 deadline 的 0 表示关闭；其余接受 1–2147483647 的整数毫秒。省略或 undefined 使用默认值。非数字 TypeError，非法数字 RangeError；检查发生在请求/读取副作用之前。Infinity 不是无限等待的写法。实际到期统一为 name 为 TimeoutError 的 Error。

SSE maxEventBytes 另按正安全整数校验，默认 8388608；0 不用于关闭事件大小限制。

### D08：运行时缺失原生方法通过文档说明

不添加 bytes 回退。原生 Response.bytes 不存在时，bytes/bytesWithTimeout 不能调用，但不影响包导入或其他已有读取方法。正式测试模拟缺失 bytes，确认调用失败不消费 body，随后 textWithTimeout 仍成功。其他原生方法也依赖运行环境对应实现。

只具备 fetch 而缺少配套 Response、Headers、ReadableStream 等 API 不满足完整运行要求。可选 body 类型检测不会无条件引用缺失的 FormData/Blob 全局；跨 realm/不同实现的 body 对象不承诺自动适配。

## 两项维护修复

- package-lock.json 顶层及根包版本从 0.1.2 同步为 package.json 的 0.1.3；没有提升库版本或改动依赖版本。
- 源码注释更新为当前 header/body/per-read 超时、取消和 SSE 语义；README、AGENTS、架构及维护指南同步更新，不再把缺陷写成长期契约。

## 迁移与验证边界

旧调用者主要需要调整 SSE 的错误处理：从检查最终 false 改为 try/catch；不要再手动删除过去误保留的协议空格。未终止的 EOF 数据不会作为错误或事件返回。超时会实际取消读取、0 会关闭期限、非法值不再交给平台隐式转换。超大 SSE 事件可按需要提高第九个参数的上限。

当前证据覆盖本机 Node 22.21.1、生成包的原生 ESM 导入、内存流和真实本地 HTTP 连接。浏览器及跨 Node 版本矩阵尚未执行；未验证 npm 上已发布版本，也未发布本地修复。库代码保持零运行时依赖，测试没有公网服务依赖。
