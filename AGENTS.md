# 项目维护约定

## 项目定位

`@czf0613/http_client` 是零运行时依赖的 TypeScript Fetch 封装，面向浏览器及具备所需 Web API 的 Node 等运行环境。提供响应头超时、五种响应体读取超时、主动取消和 SSE 字符串迭代。SSE 可以携带 HTTP 请求体，没有服务端 SSE 写入器。

原生 Node ESM 是必须支持的运行目标。运行时测试必须使用 JavaScript，由原生 Node 直接验证生成的 JS 和包入口。不要在 `src/` 引入 Node 专属运行时依赖或浏览器专属全局变量。

## 开始工作

1. 检查 `git status --short` 和当前分支，保留用户及其他任务的改动。
2. 阅读 [README](README.md) 的 API；涉及实现时阅读 [架构说明](docs/architecture.md)，涉及测试或发布时阅读 [维护指南](docs/development.md)。
3. 以源码和实测确认现状，以用户要求和明确的 API 约定确定正确行为。现有行为不自动成为需要保留的特性。[修复记录](docs/bug-audit.md) 记录了 B01–B15 和已确定的行为，不是待实施清单。

## 文件职责

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 公共运行时及类型导出 |
| `src/http_client.ts` | 查询合并、请求准备、HTTP 请求、SSE 生成器 |
| `src/response_ext.ts` | 显式委托响应 API、保留元数据、克隆与五种读取超时 |
| `src/body_stream.ts` | 可取消的流转发、reader 释放和完成通知 |
| `src/parser.ts` | 有大小上限的增量 SSE 行/事件解析 |
| `src/timer.ts` | 默认值、超时校验、计时和中止监听器清理 |
| `tests/*.test.js` | 原生 Node 运行的公开入口回归测试 |
| `tests/helpers.js` | 合成流、Fetch 替身和 timer 观测 |
| `dist/` | 忽略的构建产物，只通过构建生成 |

## 已确定的 API 边界

- 保持零运行时依赖和小而直接的实现。包根只有三个运行时函数，以及 `HttpMethod`、`ExtendedResponse` 两个类型；后者不是运行时构造器导出。
- 保留现有位置参数顺序。HTTP 的第七项和 SSE 的第八项是可选 `AbortSignal`；SSE 第九项是 `maxEventBytes`。
- HTTP 方法包含 PATCH；不新增 OPTIONS。公开 headers 保持 `Record<string, string>`，本轮不引入 `HeadersInit` 或通用 `RequestInit` 参数。
- 所有超时用 `0` 关闭，否则接受不超过 `2147483647` 的正整数毫秒。发请求或消费 body 前校验。默认值仍是 HTTP/响应体 5000 ms、SSE 两种超时各 30000 ms。
- HTTP 超时到响应头为止；五种 `*WithTimeout` 限制整段 body 读取；`messageTimeoutMs` 限制每次 `reader.read()`，不是完整 SSE 事件。不能擅自改成整条消息的期限。
- 普通 HTTP 非 OK 状态仍返回响应；SSE 非 OK 和其他失败抛异常，使 `for await` + `try/catch` 可用。SSE 正常结束保留 `true`，不返回失败 `false`，不在库内打印错误。
- SSE 采用标准行格式：LF/CRLF/CR、初始 BOM、注释、多行 data、空 data、可选的单个分隔空格。保留业务空白；忽略元数据和未知字段；EOF 丢弃未结束的事件；不自动重连；`[DONE]` 由应用处理。
- SSE 默认加入 Accept，但保留调用者设置；不强制响应 MIME。事件各行的非换行 UTF-8 字节总量默认限制为 8 MiB，包含注释及忽略字段；超限抛错并取消，不静默截断。
- Response 采用显式委托，不要求 `instanceof Response` 或原生品牌检查兼容。保留元数据、稳定绑定方法、一次性消费和扩展 clone。
- 五种超时读取依赖对应的原生转换方法。**不要为缺失的 `Response.bytes()` 添加回退或 polyfill**；只要不调用该方法，其他功能仍可使用，并在文档说明能力要求。

## 生命周期与数据处理

- 输入 headers 只读，复制后通过 `Headers` 处理大小写。显式 Content-Type 优先；FormData 例外，移除副本中的 Content-Type，让 Fetch 生成 boundary。
- 查询参数统一接受 string/number/boolean，同名键覆盖已有值，保留其他 query 和 fragment。原生二进制、表单请求体不转 JSON；不支持的顶层类型明确报错。
- 成功、失败、超时和中止都要清理 timer 和监听器。拒绝 Promise 不等于取消实际工作，必须验证流/连接的释放。
- 读超时只取消当前 clone 分支；外部 AbortSignal 作用于请求的共享输入流。不要通过共享控制器中止一个分支的读取而误伤其他 clone。
- SSE 的提前退出、非 OK、读取/解析失败必须取消未使用的 body。等待中的 `.next()` 通过 AbortSignal 中断，不能假定生成器 `.return()` 能立即中断它。
- 修改解析器时考虑每个字节分块、UTF-8、CRLF 跨块、多帧、空 payload、EOF 和超限；保持增量扫描，避免反复复制/扫描全部残留数据。
- TypeScript 使用四空格缩进。相对导入写生成文件的 `.js` 后缀，构建使用 NodeNext。不要手改 `dist/` 或通过 loader 掩盖 ESM 错误。

## 验证与交付

- 首次安装使用 `npm ci`，遵守锁文件；不为临时检查改依赖版本。
- 实现变更运行 `npm test`，其中 pretest 会构建。测试使用 JS、`node:test` 和 `node:assert/strict`，消费公开 `dist/index.js`。不用 `tsx`、`ts-node`、源码转译钩子或测试打包器替代运行时验收。
- `npm test` 只使用内存流、127.0.0.1 服务和离线安装的本地 tarball，不下载真实文件或访问第三方站点。维护包名导入和子进程自然退出检查，不能用 `process.exit()` 掩盖资源遗留。
- 新回归测试表达正确的外部行为，不把历史 bug 写成永久预期。选择与改动相称的检查；避免仅复刻实现的测试。
- 涉及发布配置时检查生成的 JS/声明、包内容以及 package.json 与锁文件版本一致性。纯文档变更检查链接、示例和 `git diff --check`，无需新增框架。
- 可见行为变更同步 README 和相关 docs。报告实际验证及限制；本机 Node 通过不能代表浏览器或完整运行环境矩阵通过。
- 提交、推送和发布按用户当前指令执行；修复代码本身不包含 npm 发布。
