# CLAUDE.md 参考模板 — 前端开发

> 本文件是 CLAUDE.md 生成参考，不要原样复制。根据用户的实际技术栈和项目结构裁剪。

---

```markdown
# <项目名称>

## 项目概述

<一句话说明项目是什么、面向什么用户。>

技术栈：<框架> / <状态管理> / <样式方案> / <构建工具>

## 命令面板

```bash
# 安装依赖
npm install / pnpm install

# 开发
npm run dev / pnpm dev

# 测试
npm test                    # 单元测试
npm run test:e2e            # E2E 测试
npm run test:watch          # 监听模式

# 类型检查
npx tsc --noEmit

# Lint & Format
npm run lint / eslint .
npm run format / prettier --write .
```

所有命令必须可直接复制运行。不要写"运行测试"，写具体的命令。

## 项目结构

```
src/
  components/
    ui/               # 通用 UI 组件，无业务逻辑
    features/         # 业务组件，按 feature 分目录
  hooks/              # 自定义 hooks
  stores/             # 客户端状态（Zustand/Pinia）
  services/           # API 调用层
  utils/              # 工具函数
  types/              # TypeScript 类型定义
  styles/             # 全局样式和主题变量
  app/ 或 pages/      # 路由页面
```

组件按功能分目录，每个目录包含组件文件、样式文件、测试文件和 index.ts。

## UI 和组件规则

1. **组件分层。** `ui/` 放无业务逻辑的通用组件（按钮、输入框、模态框），`features/` 放业务组件。通用组件不得导入 store 或 service。
2. **组件不超过 200 行。** 超过就拆分。逻辑用 custom hook 抽取，UI 用子组件拆分。
3. **Props 显式声明。** 所有组件必须定义 TypeScript interface 声明 props，禁止 `any`。
4. **Key 不用 index。** 列表渲染的 key 必须用唯一标识符（id），不用数组 index。
5. **不内联样式对象。** 样式走 CSS Modules / Tailwind / styled-components。`style={{ color: 'red' }}` 是 bug，除非是动态计算值。

## 样式规范

- 使用项目选定的样式方案，不混用多种方案。
- 颜色、间距、字号走 design token / CSS 变量，禁止硬编码 hex 值。
- 响应式优先：mobile-first，断点统一管理。
- z-index 使用预定义层级，禁止随意写 `z-9999`。
- 动画时长 150ms-300ms，使用 ease-in-out。超过 300ms 的动画需要理由。

## 状态和数据

- **服务端数据**用 React Query / SWR / TanStack Query 管理，自带缓存、重试、乐观更新。
- **客户端状态**用 Zustand / Pinia / Jotai，只存 UI 状态（侧边栏开关、选中项、表单草稿）。
- **表单状态**用 React Hook Form / Formik + Zod schema 校验。
- 不要把服务端数据复制到客户端 store 里。用 query hook 直接取。
- Context 只用于主题、语言、认证等全局 singleton，不用于业务数据传递。

## 国际化和无障碍

- 所有用户可见文本必须走 i18n 函数（`t('key')` 或 `<Trans>`），禁止硬编码中文/英文字符串。
- 新增翻译 key 同时更新所有语言的翻译文件。
- 图片必须有 `alt` 属性。装饰性图片用 `alt=""`。
- 可交互元素必须可键盘访问（Enter/Space 触发，Tab 切换焦点）。
- 表单输入必须有关联的 `<label>` 或 `aria-label`。
- 颜色对比度符合 WCAG AA 标准（至少 4.5:1）。

## 非协商规则

1. **禁止 `any` 类型。** 每个 `any` 都是潜在的运行时 bug。不确定类型用 `unknown` + 类型守卫。
2. **所有用户可见文本必须走 i18n。** 这是硬规则，包括 placeholder、错误提示、按钮文案。review 时直接打回硬编码字符串。
3. **组件不直接调用 fetch/axios。** API 调用集中在 `services/` 层，组件通过 hook 调用 service。
4. **不使用 `useEffect` 做数据转换。** `useEffect` 只用于副作用（API 调用、订阅、DOM 操作），数据转换用 `useMemo`。
5. **新增组件必须有测试。** 至少覆盖渲染测试 + 用户交互测试。关键组件需要 snapshot 或 Storybook。

## 测试规范

- 组件单元测试：渲染 + 用户交互（点击、输入、表单提交）。
- Hook 测试：使用 `renderHook`。
- E2E 测试覆盖核心用户流程（注册、登录、核心操作）。
- Mock API 响应，不依赖后端服务。
- 测试文件与组件文件同目录，命名 `ComponentName.test.tsx`。

## Scoped Guidance

以下主题建议拆分为独立 Skill/Rules 文件，按需加载：

- **性能优化**：懒加载、虚拟列表、图片优化、bundle 分析 -> `skills/performance-rules.md`
- **设计系统**：组件库规范、token 体系、Storybook 规范 -> `skills/design-system-rules.md`
- **路由规范**：路由命名、嵌套路由、权限路由、404 处理 -> `skills/routing-rules.md`
- **状态管理详细规范**：store 结构、action 命名、devtools 使用 -> `skills/state-rules.md`
- **部署和构建**：环境变量、CDN 配置、Sourcemap 策略 -> `skills/deploy-rules.md`
```

---

## 使用说明

- 替换所有 `<占位符>` 为实际内容
- 样式方案、状态管理等选项根据项目实际技术栈选择，删除不相关的
- i18n 和无障碍规则如果项目暂不支持，可以移到 Scoped Guidance 或标注为 TODO
- 非协商规则必须具体到可执行
- Scoped Guidance 列出扩展主题但不展开，避免主文件过长
- 总行数控制在 100-150 行
