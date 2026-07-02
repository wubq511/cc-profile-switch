# CLAUDE.md 参考模板 — 学术研究/数据科学

> 本文件是 CLAUDE.md 生成参考，不要原样复制。根据用户的研究领域和工具链裁剪。

---

```markdown
# <研究项目名称>

## 研究概述

<一句话说明研究问题、使用的方法、目标产出。>

领域：<学科方向>
数据类型：<实验数据 / 调查数据 / 模拟数据 / 公开数据集>
产出类型：<论文 / 报告 / 可视化仪表板 / 开源工具>

## 命令面板

```bash
# 环境
conda env create -f environment.yml     # 创建环境
conda activate <project>                 # 激活环境
pip install -r requirements.txt          # 或用 pip

# 数据处理
python scripts/preprocess.py             # 数据预处理
python scripts/analyze.py                # 运行分析

# Notebook
jupyter lab                              # 启动 Jupyter
jupyter nbconvert --to notebook --execute notebooks/*.ipynb  # 全量重跑

# 测试
pytest tests/ -v                         # 运行测试
pytest tests/ -v --cov=src               # 带覆盖率

# 论文/报告
make paper                               # 编译论文（LaTeX）
make slides                              # 编译幻灯片
```

所有命令必须可直接复制运行。环境配置一条命令搞定，不写"安装依赖"。

## 项目结构

```
project/
  data/
    raw/             # 原始数据，只读，不修改
    processed/       # 处理后的数据，由脚本生成
    external/        # 外部数据源
  notebooks/         # 探索性分析和实验
    exploratory/     # 探索阶段，允许不整洁
    final/           # 最终可复现的 notebook
  scripts/           # 可复用脚本，从 notebook 沉淀而来
  src/               # 自研库/工具包代码
  tests/             # 脚本和工具的单元测试
  results/
    figures/         # 生成的图表
    tables/          # 生成的表格
    models/          # 训练的模型
  docs/              # 论文、报告、笔记
  references/        # 参考文献
```

`data/raw/` 目录加入 `.gitignore`，不提交到版本控制。

## 可复现规则

1. **Notebook 必须从头到尾可运行。** Kernel Restart & Run All 不能报错。每次提交前执行全量重跑，确认输出一致。
2. **禁止硬编码路径。** 数据路径、输出路径统一用配置文件或环境变量管理。`/Users/robertwu/data/xxx` 是 bug。
3. **配置单元放在最前面。** Notebook 第一个 cell 放所有 import、路径配置、随机种子、超参数。后续 cell 不重复 import。
4. **固定随机种子。** 所有涉及随机性的操作（train/test split、模型初始化、数据增强）必须设置 `random.seed()` / `np.random.seed()` / `torch.manual_seed()`。
5. **记录环境版本。** `environment.yml` 或 `requirements.txt` 必须包含精确版本号。`pip freeze > requirements.txt`。
6. **数据处理流水线可追溯。** 从 raw 到 processed 的每一步必须有对应脚本或 notebook cell。手动 Excel 操作无法复现。

## 分析规则

- 每个分析步骤写清楚三件事：输入是什么、做了什么处理、输出是什么。
- 统计检验明确写出：检验方法名称、假设、p 值、置信区间、效应量。不要只写"显著"。
- 图表必须有：标题、坐标轴标签（含单位）、图例、数据来源标注。
- 数值精度：报告的均值、标准差等统计量保留合理有效数字，不过度精确。
- 优先使用库的内置函数而不是手写实现。`scipy.stats.ttest_ind` 优于手写 t 检验。
- 异常值处理必须在报告中说明策略和理由，不要静默删除。

## 写作和引用

- 学术引用必须来自真实来源并可核验。不猜 DOI，不编造参考文献。每个引用的 URL 必须可访问。
- 引用管理：使用 BibTeX / Zotero / Mendeley，不手动写参考文献列表。
- 图表编号连续：Figure 1, Figure 2，不跳号。正文中必须引用每张图和每张表。
- 缩写首次出现时展开全称，之后直接用缩写。
- 结论必须说明局限性。没有局限性的研究不可信。

## 非协商规则

1. **`data/raw/` 只读。** 原始数据不修改、不覆盖、不删除。所有处理生成新文件到 `data/processed/`。
2. **禁止在 notebook 里硬编码随机种子后又在不同 cell 里重设。** 种子在配置单元统一设置一次。
3. **图表颜色不能仅依赖颜色区分信息。** 必须同时用形状、纹理或标签辅助，确保色盲可读。
4. **不提交 notebook 输出。** 使用 `nbstripout` 或 pre-commit hook 清理 notebook 输出后再 commit。
5. **模型结果不微调到过拟合。** 必须有独立的验证集或交叉验证，不能只看训练集指标。

## Notebook 规范

- 探索性 notebook 放 `notebooks/exploral/`，不要求整洁，但必须能运行。
- 稳定后的分析沉淀为脚本到 `scripts/`，notebook 只保留探索过程。
- `notebooks/final/` 下的 notebook 是最终可交付版本，整洁、有注释、可从头运行。
- 长 notebook（超过 50 个 cell）拆分为多个 notebook，按分析阶段命名。
- Markdown cell 解释每个代码块的目的。不要假设读者能看懂裸代码。

## Scoped Guidance

以下主题建议拆分为独立 Skill/Rules 文件，按需加载：

- **机器学习规范**：特征工程、模型选择、超参调优、模型保存 -> `skills/ml-rules.md`
- **可视化规范**：配色方案、字体大小、导出格式、图表类型选择 -> `skills/visualization-rules.md`
- **LaTeX 写作规范**：模板使用、公式编号、交叉引用、编译流程 -> `skills/latex-rules.md`
- **数据管理规范**：FAIR 原则、数据字典、隐私脱敏、备份策略 -> `skills/data-management-rules.md`
- **协作规范**：分支策略、PR 规范、代码审查、贡献指南 -> `skills/collaboration-rules.md`
```

---

## 使用说明

- 替换所有 `<占位符>` 为实际内容
- 项目结构根据研究实际调整，但 `data/raw/` 只读的原则不变
- 分析规则根据领域调整（生物统计、物理实验、社会科学各有侧重）
- LaTeX 写作规范只在用 LaTeX 时激活，Markdown 写作则参考技术写作模板
- 非协商规则必须具体到可执行和可验证
- 总行数控制在 100-150 行
