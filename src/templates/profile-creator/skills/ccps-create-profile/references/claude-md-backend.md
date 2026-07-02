# CLAUDE.md 参考模板 — 全栈/后端开发

> 本文件是 CLAUDE.md 生成参考，不要原样复制。根据用户的实际技术栈和项目结构裁剪。

---

```markdown
# <项目名称>

## 项目概述

<一句话说明项目是什么、解决什么问题。>

技术栈：<语言> / <框架> / <数据库> / <部署方式>

## 命令面板

```bash
# 安装依赖
npm install / pip install -r requirements.txt / go mod download

# 开发
npm run dev / uvicorn main:app --reload / air

# 测试
npm test / pytest -x / go test ./...

# 类型检查
npx tsc --noEmit / mypy src/

# Lint & Format
npm run lint / ruff check --fix / golangci-lint run
npm run format / ruff format / gofmt -w .
```

所有命令必须可直接复制运行。不要写"运行测试"，写具体的命令。

## 项目结构

```
src/
  api/            # 路由/控制器，只做参数校验和响应格式化
  services/       # 业务逻辑，核心编排层
  repositories/   # 数据访问，封装所有数据库操作
  models/         # 数据模型/schema 定义
  middleware/     # 中间件（认证、日志、错误处理）
  utils/          # 通用工具函数
tests/
  unit/           # 单元测试，mock 所有外部依赖
  integration/    # 集成测试，使用测试数据库
  fixtures/       # 测试数据
```

新增文件必须放入对应层级。不确定放在哪时，在代码注释中标注 TODO 并说明理由。

## 非协商规则

1. **路由不直接访问数据库。** 所有数据库操作必须经过 service -> repository 两层。违反此规则的代码在 review 中直接打回。
2. **新接口必须有测试。** 新增 API endpoint 必须同时提交对应的单元测试或集成测试。修复 bug 必须先写一个复现该 bug 的失败测试，再修复。
3. **Schema 变更只通过 migration。** 禁止手动修改数据库结构。每次 schema 变更必须生成对应的 migration 文件，并提供 rollback 方案。
4. **错误不吞掉。** 捕获异常后必须：记录日志、返回合适的错误响应、或重新抛出。空 catch 块是 bug。
5. **不做 N+1 查询。** 涉及列表 + 关联数据的接口，必须检查查询次数。优先使用 eager loading 或 batch query。

## 测试规范

- 单元测试覆盖核心业务逻辑，覆盖率不低于 80%。
- 每个 service 方法至少一个 happy path + 一个 error path 测试。
- 集成测试使用独立的测试数据库，测试前后自动清理数据。
- Mock 外部服务（支付、邮件、第三方 API），不依赖真实外部调用。
- 测试命名：`should_<行为>_when_<条件>`。
- 修复 bug 时，先写一个能复现 bug 的失败测试，确认失败后再修复代码。

## 编码规范

- 函数不超过 50 行。超过就拆分。
- 变量和函数命名：描述用途，不描述实现。`getUserById` 好，`queryFromDb` 差。
- 注释解释 WHY，不解释 WHAT。代码本身应该自解释 WHAT。
- 公共函数必须有 JSDoc/docstring，包含参数说明和返回值说明。
- 配置项走环境变量或配置文件，禁止在代码中硬编码密钥、URL、端口号。

## Git 提交规范

格式：`<type>(<scope>): <description>`

type：feat / fix / refactor / test / docs / chore / perf

示例：`feat(auth): add JWT refresh token endpoint`

每个 commit 应该是一个可独立部署的逻辑单元。不要把不相关的改动混在一个 commit 里。

## Scoped Guidance

以下主题建议拆分为独立 Skill/Rules 文件，按需加载：

- **数据库规范**：migration 命名、索引策略、连接池配置 -> `skills/db-rules.md`
- **API 设计规范**：RESTful 约定、分页/筛选/排序、版本策略 -> `skills/api-rules.md`
- **安全规范**：认证流程、输入校验、SQL 注入防护、CORS 配置 -> `skills/security-rules.md`
- **部署规范**：Docker 构建、CI/CD 流程、环境变量管理 -> `skills/deploy-rules.md`
- **性能规范**：缓存策略、查询优化、异步任务 -> `skills/performance-rules.md`
```

---

## 使用说明

- 替换所有 `<占位符>` 为实际内容
- 命令面板只保留项目实际使用的命令，删除不相关的
- 非协商规则必须具体到可执行，不要写"写好代码"这种废话
- Scoped Guidance 列出用户可能需要的扩展主题，但不展开写，避免主文件过长
- 总行数控制在 100-150 行
