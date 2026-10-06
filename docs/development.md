# 开发与验证

项目行为见 [README](../README.md)，实现说明见 [架构文档](architecture.md)，B01–B15 的对应修复见 [修复记录](bug-audit.md)。

## 环境与构建

项目使用 TypeScript 开发库，使用 JavaScript 编写运行时测试。没有运行时依赖，开发依赖是 TypeScript 和 Node 类型声明。

2026-10-06 的验证环境为 Node `22.21.1`、npm `10.9.4`、TypeScript `5.9.3`。这是一套已验证环境，不等于声明所有更早/更晚版本或浏览器兼容；package.json 暂未设置 engines。

```sh
npm ci
npm run build
npm test
```

`npm test` 的 pretest 已包含 build，日常完整验证只需运行 npm test。`tsconfig.json` 使用 NodeNext 模块及解析规则，目标 ES2018，标准库包含 DOM。相对 import 在 TypeScript 源码中写 `.js`，生成 JS 和声明中的路径可由原生 ESM 解析。编译包含 src，不转译测试。

`dist/` 是忽略的生成目录，只通过构建更新。不要直接修补构建产物。测试不得使用 tsx、ts-node 或测试打包器，否则可能再次掩盖源码到发布包之间的导入问题。

## 回归测试

```sh
npm test
```

运行 `node --test --test-timeout=10000 tests/*.test.js`。每个测试文件直接导入公共 `dist/index.js`；没有旧版的公网 Bing/大型下载脚本，也不需要临时下载测试运行器。

| 文件 | 验证内容 |
| --- | --- |
| [http.test.js](../tests/http.test.js) | URL 合并、PATCH/boolean、只读 headers、Content-Type、原生请求体、请求超时与取消 |
| [response.test.js](../tests/response.test.js) | 五种原生转换、超时取消、异常、元数据/反射、clone 隔离、bytes 能力缺失和 signal 清理 |
| [sse.test.js](../tests/sse.test.js) | 标准行格式与分块、EOF、for-await 错误传播、提前退出、逐次读取期限、上限及增量组装 |
| [integration.test.js](../tests/integration.test.js) | 127.0.0.1 HTTP 服务实际接收的数据、重定向元数据、header/body/SSE 取消后连接关闭 |
| [package.test.js](../tests/package.test.js) | 本地 tarball 离线安装、按包名原生导入、版本一致性、子进程自然退出 |
| [helpers.js](../tests/helpers.js) | 合成字节流、可观测取消、Fetch 替身和 timer 跟踪 |

包测试先 `npm pack --ignore-scripts`，因为 pretest 已构建，然后在临时 consumer 目录以 `npm install --offline --ignore-scripts` 安装该 tarball。新 Node 子进程按包名导入并实际读取 data URL，测试结束删除临时目录。没有 npm 发布或外部请求。

生命周期测试既断言返回值/错误，又观测源取消、reader 锁、timer 与监听器。进程退出检查使用很长的业务 deadline 和较短的子进程保护期限，确保成功/失败后的无用 timer 不继续挂住进程。测试不得以 `process.exit()` 掩盖泄漏。

本地服务绑定随机端口，结束时关闭连接和 server。无需联网服务、真实凭据或下载大型文件。依赖安装阶段的 npm ci 与测试自身的本地/离线运行是两件事。

只运行某组测试时先构建，例如：

```sh
npm run build
node --test --test-timeout=10000 tests/sse.test.js
```

新增测试应针对用户可见的回归和资源生命周期，使用小型合成数据和有界等待。不把不正确的历史行为作为兼容性断言，也不以 TypeScript 类型检查替代运行时测试。

## GitHub Actions

[CI 工作流](../.github/workflows/ci.yml) 在推送 master、pull request 和手动触发时运行。Ubuntu 上分别使用 Node 22、24，两项任务独立执行 `npm ci` 和 `npm test`；构建、本地连接测试、tarball 离线安装及原生导入都包含在内。

工作流缓存 npm 下载内容，依据锁文件恢复依赖；每项任务上限 10 分钟。checkout/setup-node 固定到已核对的版本 commit，token 只需 contents: read。同一分支的新运行取消旧运行，矩阵中一项失败不会提前取消另一项。

实际运行结果以 [GitHub Actions](https://github.com/czf0613/http_client_ts/actions/workflows/ci.yml) 为准。ci.yml 只验证 Node，不构成浏览器兼容性验收；npm 发布由独立的 publish.yml 处理。

## 包内容与发布

当前版本以 package.json 为准，并与 package-lock.json 的两处版本保持一致。包声明 `type: module`，入口为 `dist/index.js`，类型入口为 `dist/index.d.ts`。

```sh
npm pack --dry-run
```

此命令通过 prepack 构建并预览包，不发布。`files: ["dist"]` 仅包含构建产物；npm 还会包含 README、LICENSE 和 package.json。AGENTS、docs、源码和测试不在当前发布白名单中。

README 同时作为仓库和 npm 说明，末尾维护链接指向仓库文件；这些 docs 文件不随 tarball 安装。发布配置改动必须检查实际 tarball 和消费者导入，仅能 build 或 pack 还不够。

需要直接确认工作区入口时可执行：

```sh
node --input-type=module -e 'import("./dist/index.js").then(m => console.log(Object.keys(m)))'
```

应看到三个运行时函数。`ExtendedResponse`、`HttpMethod` 是类型导出，不应出现在 Object.keys 中。

### 自动发布到 npm

[publish.yml](../.github/workflows/publish.yml) 在 GitHub Release 发布时触发，跳过 prerelease。它检出 release tag，核对 tag 与 package.json/锁文件版本一致，在 Node 24 上安装依赖并完成 npm test，然后通过 OIDC 执行 `npm publish --access public`。标签可使用 `0.2.0` 或 `v0.2.0` 形式，现有仓库使用前者。

npm Trusted Publisher 对应用户 `czf0613`、仓库 `http_client_ts`、文件名 `publish.yml`，不限定 Environment，并允许 npm publish。无需长期 NPM_TOKEN。工作流使用 GitHub 托管 runner、具备 OIDC 支持的 npm 和 `id-token: write` 权限；发布构建关闭依赖缓存。[npm 配置说明](https://docs.npmjs.com/trusted-publishers/)

用户授权发布后，按以下流程执行：

1. 同步 package.json/锁文件版本，更新发布说明，运行 npm test 和包内容检查。
2. 提交并推送 master，确认该提交的 Node 22/24 CI 通过。
3. 为同一提交创建并推送版本 tag，发布对应 GitHub Release；这一步会触发 npm 发布。
4. 确认 Publish npm 成功，在 npm registry 检查新版本，并从临时消费者目录安装验证。

不能重复发布已有的 name/version 组合。普通 push、PR 和草稿 Release 不会执行 npm publish。创建正式 Release 已是发布动作，不应在仅要求提交代码时顺带执行。

## 当前验证记录

2026-10-06，修复后的本地工作区：

| 检查 | 结果 |
| --- | --- |
| `npm test`（含 TypeScript 构建） | 43 项通过，0 失败、0 跳过、0 取消；包括 3 项嵌套 SSE 连接测试 |
| 原生 JS 直接导入 dist 与安装后的包名入口 | 通过，由正式测试持续覆盖 |
| 真实本地 HTTP 取消与数据传递 | 通过，由正式测试持续覆盖 |
| 缺少原生 Response.bytes 的场景 | 调用 bytesWithTimeout 报错，其他方法仍正常；无回退 |
| 浏览器运行、跨 Node 版本矩阵、已发布 npm 包 | 未验证 |

B01 的最初红灯是原生 JS 测试报告 ERR_MODULE_NOT_FOUND；修复源码后同一测试入口可以运行。早期临时探针已经被正式 JS 回归测试替代，不再作为验收依据。

## 文档维护

可见 API 改动同步 README、架构说明和 AGENTS。修改已有问题的行为时更新修复记录，明确迁移影响。纯文档调整检查本地链接、代码围栏、示例与源码的一致性，以及 `git diff --check`；无须重复与文档无关的运行时测试。
