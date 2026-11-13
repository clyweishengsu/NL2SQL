# 模板 06：黄金 SQL 示例库组织规范（Few-shot 库建设）

> 文件：`prompts/06-黄金SQL示例库组织规范.md`
> 版本：v1.1.0 ｜ 产出人：文达意 ｜ 日期：2026-09
> 对应功能：**F-19 黄金 SQL 示例库** + **F-22 反馈闭环**（验收 §2 F-19「示例生效/停用不生效/反馈沉淀」）
> 上游依据：`docs/PRD-自然语言转SQL.md` §7.6（golden_sql 实体）、验收 §5（Golden SQL 回归集规范）、研究 §3.2「Vanna 三元组 / SuperSonic Chat Memory」
> **示例 Schema 底座**：`tests/golden/00-示例Schema-招投标业务.md`（全项目唯一）
> 消费方：配置台 P-06、反馈闭环、模板 01 的示例分区

---

## 0. 核心结论（先看这里）

| # | 结论 |
|---|---|
| 1 | 示例库是**准确率的第一杠杆**（行业证据：10~20 条黄金 SQL 可把准确率从 ~60% 拉到 90%+），建设必须规范、可控、可防污染。 |
| 2 | 字段结构与 PRD §7.6 `golden_sql` 实体**严格对齐**，并与验收 §5.3 回归集标注格式**同构**（示例可直接升级为回归集用例）。 |
| 3 | 检索选取遵循「**向量相似度 + 同表优先 + 难度匹配**」三因子，K 默认 **3**（区间 3~5，按预算与问题复杂度调整）。 |
| 4 | 沉淀必须过**三道校验**（可执行 + 结果正确 + 人工/回归确认）才能入**正式库**；未经校验的只能进「待验证」暂存区。 |
| 5 | 设**质量红线**：写操作、含真实敏感数据、依赖未配置表、非查询类一律禁止入库。 |
| 6 | **示例库与回归集同底座、不同题面**（§7 防泄题约定）：示例库题面不得与 `01-GoldenSQL回归集` 任意一条相同或近似，否则会虚高 Pass@1。 |

---

## 1. 示例库字段结构（对齐 PRD §7.6 + 验收 §5.3）

| 字段 | 类型 | 必填 | 说明 | 示例 |
|---|---|---|---|---|
| id | string | 是 | 唯一编号 | ex_001 |
| question | text | 是 | 自然语言问题（**真实口语**） | 各地区参与投标的企业数量分别是多少 |
| sql_text | text | 是 | 标准 SQL（经确认，单条 SELECT） | SELECT ... |
| related_tables | json | 是 | 涉及表 | ["t_bid_record","t_section","t_project","t_region"] |
| difficulty | enum | 否 | 简单/中等/困难 | 中等 |
| status | enum | 是 | 待验证/已验证/已废弃 | 已验证 |
| source | enum | 是 | 人工 / 反馈沉淀 | 人工 |
| enabled | bool | 是 | 是否启用 | true |
| created_at | datetime | 是 | 时间戳 | 2026-09-15 10:00 |

### 1.1 与验收 §5.3 回归集字段的映射（同一数据可双用）

| 回归集字段（验收 §5.3） | 示例库字段 | 说明 |
|---|---|---|
| id | id | 编号体系区分：回归集用 `GS-xxx`，示例库用 `ex_xxx`（防混用、防泄题） |
| category | （difficulty 辅助） | 回归集多一个"类别"字段；示例库可用 related_tables + difficulty 近似 |
| question | question | 完全一致（但**题面不得重复**，见 §7） |
| golden_sql | sql_text | 完全一致 |
| related_tables | related_tables | 完全一致 |
| difficulty | difficulty | 完全一致 |
| expected_check | （回归集专有） | 仅回归集需要 |
| expected_result_ref | （回归集专有） | 仅回归集需要 |
| notes | （可另存备注） | 口径/陷阱说明 |

> **结论**：一条"已验证"的示例，只需补 `category`/`expected_check`/`expected_result_ref` 即可升级为回归集用例（GS），避免重复维护。**但一旦升级为回归集测试题，建议将其从 Few-shot 注入集中移出**（防泄题，见 §7）。

---

## 2. 检索与选取策略

### 2.1 三因子打分

```
score(example, question) =
    0.55 * sim_vec(question, example.question)        # 向量语义相似度（主）
  + 0.30 * overlap(recall_tables, example.related_tables)  # 同表优先（命中表重合度）
  + 0.15 * difficulty_match(question_complexity, example.difficulty)
```

| 因子 | 计算 | 说明 |
|---|---|---|
| `sim_vec` | 问句向量余弦相似度 | 对 `question` 建索引；相似问题复用写法 |
| `overlap` | Jaccard(召回表, 示例涉及表) | **同表优先**：优先给当前问题涉及表的示例（表结构一致，示例更可靠） |
| `difficulty_match` | 1 - |问题复杂度 - 示例难度|/2 | 复杂度由问题特征估算（表数、是否有聚合/时间/分组） |

### 2.2 K 的取值

| K | 适用 | 依据 |
|---|---|---|
| **3（默认）** | 常规问题 | 预算 25% 内可容纳；过多示例会挤占元数据预算（README §3.2） |
| 5 | 复杂问题（多表 join + 聚合 + 术语） | 更多写法参考 |
| 1 | 元数据超预算 / 简单单表问题 | 裁剪优先级 L1 先减示例 |
| 0 | 无相似示例 / 预算极紧 | 走零样本 |

### 2.3 选取流程

```
1. 过滤：enabled=true 且 status=已验证 → 候选池。
2. 向量检索候选池 Top-10。
3. 三因子打分排序。
4. 去重：与当前问题语义重复度过高（sim>0.95）的同表示例只保留 1 条。
5. 取 Top-K（默认 3），按「同表优先」再排序，注入模板 01 示例分区。
6. 预算裁剪时按 L1 递减 K。
```

### 2.4 示例渲染格式（供 `{{few_shot_examples}}`）

```text
### 示例 1
问题：<question>
SQL：<sql_text>
（涉及表：<related_tables>；难度：<difficulty>）
```

---

## 3. 沉淀机制（反馈闭环 → 示例库）

### 3.1 来源与流程

```
[用户采纳] ─► 直接计采纳率（F-22），不自动入库
[用户纠错] ─► 提交正确 SQL ─► 进入「待验证」暂存区（source=反馈沉淀, status=待验证）
                                   │
                                   ▼ 三道校验
                       ① 只读校验（F-12 SELECT-only）
                       ② 可执行 + 结果正确性校验（在固定数据集执行）
                       ③ 人工确认口径（数据管理员）或 回归集印证
                                   │
              全部通过 ─► status=已验证, enabled=true ─► 入正式库
              任一失败 ─► 打回/丢弃，不入库
```

### 3.2 三道校验（缺一不可）

| 校验 | 内容 | 责任人 |
|---|---|---|
| ① 只读校验 | AST 解析，单条 SELECT，无写/DDL | 系统（F-12） |
| ② 结果校验 | 在固定数据集执行，结果与用户确认的正确结果一致 | 系统 |
| ③ 口径确认 | 涉及术语/口径的，由数据管理员确认（含税/单位/时间范围/枚举含义等） | 人工（R2） |

### 3.3 状态流转

`待验证 → 已验证`（通过校验）；`已验证 → 已废弃`（口径变更/表结构变更）；`任意 → 已废弃`（人工停用）。

---

## 4. 示例质量红线（禁止入库）

| # | 红线 | 说明 |
|---|---|---|
| 1 | 含写操作 | 出现 INSERT/UPDATE/DELETE/DDL/多语句 → 直接拒绝（只读红线） |
| 2 | 含真实敏感数据 | SQL 中硬编码身份证/手机号/银行账号等真实值 → 拒绝 |
| 3 | 依赖未配置/已废弃表 | 引用的表不在已发布元数据中，或 status=已废弃 → 拒绝 |
| 4 | 非查询类 | 与数据查询无关（闲聊、指令） → 拒绝 |
| 5 | 口径未经确认 | 涉及关键口径（含税/单位/时间边界/枚举含义）但无 notes 说明且未人工确认 → 先入「待验证」 |
| 6 | 硬编码业务量 | 把"某个具体企业名/项目编号"写死却当作通用示例（语义过窄） → 标注适用范围或拒绝 |
| 7 | 结果不可复现 | 依赖执行时点数据而无稳定口径（如"今天"） → 改为明确时间边界或拒绝 |
| 8 | **与回归集题面重复** | 题面与 `01-GoldenSQL回归集` 任一条相同/近似 → 不得同时进 Few-shot 注入集（泄题，见 §7） |

---

## 5. 填写样例（5 条种子示例，招投标业务口径）

> 底座：`tests/golden/00-示例Schema-招投标业务.md`。以下 5 条为**可直接启用的示例库种子**，均与回归集题面不同（防泄题），并覆盖不同能力维度。

### 示例 ex_001（简单｜单表聚合 + 分组）

```json
{
  "id": "ex_001",
  "question": "各类企业类型分别有多少家投标企业？",
  "sql_text": "SELECT c_type, COUNT(*) AS comp_cnt FROM t_company GROUP BY c_type ORDER BY comp_cnt DESC",
  "related_tables": ["t_company"],
  "difficulty": "简单",
  "status": "已验证",
  "source": "人工",
  "enabled": true,
  "created_at": "2026-09-15 10:00"
}
```
> 口径：`c_type` 1=施工总承包,2=专业承包,3=设计,4=其他（**需元数据配置，原生注释无含义**）。

### 示例 ex_002（中等｜多表 join + 术语口径「中标」）

```json
{
  "id": "ex_002",
  "question": "各企业各中标了多少次？列出中标次数最多的前 5 家。",
  "sql_text": "SELECT c.c_nm, COUNT(*) AS win_cnt FROM t_bid_record b JOIN t_company c ON b.c_id = c.c_id WHERE b.rst = 2 GROUP BY c.c_nm ORDER BY win_cnt DESC LIMIT 5",
  "related_tables": ["t_bid_record", "t_company"],
  "difficulty": "中等",
  "status": "已验证",
  "source": "人工",
  "enabled": true,
  "created_at": "2026-09-15 10:05"
}
```
> 口径：**「中标」= rst=2**（原生注释无枚举说明，必须靠元数据）。

### 示例 ex_003（中等｜术语口径「评标价」，与「中标金额」形成对照）

```json
{
  "id": "ex_003",
  "question": "各标段的评标价平均值是多少？",
  "sql_text": "SELECT s.sec_nm, AVG(b.amt_a) AS avg_eval FROM t_bid_record b JOIN t_section s ON b.sec_no = s.sec_no GROUP BY s.sec_nm",
  "related_tables": ["t_bid_record", "t_section"],
  "difficulty": "中等",
  "status": "已验证",
  "source": "人工",
  "enabled": true,
  "created_at": "2026-09-15 10:10"
}
```
> 口径：**「评标价」= `amt_a`**；与「中标金额」(`bid_price` + rst=2) 是**不同字段**——本条与 ex_002 构成"同是价格/金额，选不同字段"的对照示例，是应对**相似歧义列名**的关键素材。

### 示例 ex_004（中等｜时间范围 + 空值语义）

```json
{
  "id": "ex_004",
  "question": "2025 年里已经开过标的标段共有几个？",
  "sql_text": "SELECT COUNT(*) AS opened_cnt FROM t_section WHERE bid_open_dt IS NOT NULL AND bid_open_dt >= '2025-01-01' AND bid_open_dt < '2026-01-01'",
  "related_tables": ["t_section"],
  "difficulty": "中等",
  "status": "已验证",
  "source": "人工",
  "enabled": true,
  "created_at": "2026-09-15 10:15"
}
```
> 口径：**`bid_open_dt` 为空 = 尚未开标**（语义，非"缺失"），因此"已开标"用 `IS NOT NULL`；时间用半开区间。

### 示例 ex_005（困难｜四级 join + 区域口径，陷阱正例）

```json
{
  "id": "ex_005",
  "question": "各地区参与投标的企业数量分别是多少？",
  "sql_text": "SELECT r.reg_nm, COUNT(DISTINCT b.c_id) AS comp_cnt FROM t_bid_record b JOIN t_section s ON b.sec_no = s.sec_no JOIN t_project p ON s.prj_no = p.prj_no JOIN t_region r ON p.region_cd = r.reg_cd GROUP BY r.reg_nm ORDER BY comp_cnt DESC",
  "related_tables": ["t_bid_record", "t_section", "t_project", "t_region"],
  "difficulty": "困难",
  "status": "已验证",
  "source": "人工",
  "enabled": true,
  "created_at": "2026-09-15 10:20"
}
```
> **陷阱点（正面示范）**：区域统计**必须走四级链路用规范 `region_cd`**，不得用 `t_bid_record.reg_txt`（中英混写脏数据）或 `t_company.area_txt`（口径不一致）。对应的反例（用户只说"金额/地区"→ 必须澄清）见模板 01 §5.3。

---

## 6. 已知边界与失败模式

| 失败模式 | 现象 | 缓解 |
|---|---|---|
| 污染 | 未验证示例入库导致后续生成被带偏 | 三道校验 + status=待验证暂存 + 质量红线 |
| 过拟合 | 示例太窄（写死企业名/项目编号）导致模型照抄 | 红线 6 + 示例尽量参数化 |
| 泄题 | 示例与回归集同题 → Pass@1 虚高 | 红线 8 + §7 约定，示例库用 `ex_` 前缀、题面独立撰写 |
| 陈旧 | 表结构变更后示例失效 | 表结构同步时标记 related_tables 命中的示例，触发复核 |
| 冲突 | 两条示例口径矛盾 | 发布前人工核对；以术语库口径为准 |
| 预算挤占 | 示例过多挤占元数据 | K 动态调整 + README §3.2 L1 优先减示例 |
| 时间失效 | 示例含固定时间（如 2025 年）逐步过时 | 示例时间作为"写法参考"，模板 01 要求以 `{{current_date}}` 重算 |

---

## 7. 防泄题约定（示例库 ↔ 回归集）

| 场景 | 约定 |
|---|---|
| 编号体系 | 回归集用 `GS-xxx`；示例库用 `ex_xxx`，互不混用。 |
| 题面独立 | 示例库题面须**自行撰写**，不得与 `01-GoldenSQL回归集` 任一条相同或近似。 |
| 双用地雷 | 若某"已验证"示例升级为回归集测试题（补 category/expected_check/expected_result_ref 即可，见 §1.1），**必须同时将其移出 Few-shot 注入集**，或改为 `enabled=false`。 |
| 理由 | 测试题一旦作为 Few-shot 注入，模型等于"提前看到答案"，Pass@1 会虚高，回归集失去客观性（验收 §5 门禁失真）。 |
| 建议 | 回归集 20~50 条题面**全部独立于示例库**；示例库覆盖相同能力维度（术语/多跳 join/NULL/相似列名）但用不同问法。 |

---

## 8. [待确认]

| # | 项 | 建议默认 |
|---|---|---|
| 1 | 示例库规模（正式库） | 10~20 条起步（行业证据），V1 扩到 50 |
| 2 | K 最终取值 | 3 |
| 3 | 「待验证」是否可被检索 | 建议**不参与**问数检索，仅占位提示 |
| 4 | 示例时间是否需要"相对化"改写 | 建议保留原文 + 标注"时间需按当前日期重算" |
| 5 | 是否自动从采纳记录挖掘（F-30，V2） | 本期不做，仅反馈沉淀 |
| 6 | 回归集与示例库的"题面相似度"判定阈值 | 建议人工评审 + 向量相似度 >0.9 视为近似，须二选一 |

---

## 变更记录

| 日期 | 版本 | 人 | 内容 |
|---|---|---|---|
| 2026-09 | v1.0.0 | 文达意 | 首版：字段结构（对齐 §7.6）、三因子检索、三道校验沉淀、质量红线、5 条行业样例 |
| 2026-09 | v1.1.0 | 文达意 | 对齐 `tests/golden/00-示例Schema`：5 条种子示例改用统一底座（t_company/t_bid_record/t_section/t_project/t_region）；新增 §7 防泄题约定（示例库 `ex_` 与回归集 `GS-` 分离、题面独立）；质量红线新增第 8 条 |
