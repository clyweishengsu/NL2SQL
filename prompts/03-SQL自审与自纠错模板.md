# 模板 03：SQL 自审与自纠错模板

> 文件：`prompts/03-SQL自审与自纠错模板.md`
> 版本：v1.1.0 ｜ 产出人：文达意 ｜ 日期：2026-09
> 对应功能：**F-20 SQL 自纠错回灌**（配合  校验、执行）

---

## 0. 核心结论（先看这里）

| # | 结论 |
|---|---|
| 1 | 本模板含**两条独立分支**：`pre_check`（事前自审，生成后、执行前，**不改语义只挑结构性错误**）与 `post_error`（事后纠错，拿到数据库真实报错后重写）。 |
| 2 | **重试上限 ≤ 2 次**（硬约束，写入模板 + 由程序强制）；**每次重试前必须重跑 F-12 SELECT-only 校验**——这是不可绕过的红线。 |
| 3 | 统一输出 JSON：`verdict`、`issues[]`、`fixed_sql`、`explanation`。 |
| 4 | 事前自审**只查结构性问题**：只读合规、方言正确、join 是否漏、聚合是否漏 GROUP BY、时间边界是否含端点、NULL 处理；**不得改变查询语义**。 |
| 5 | 事后纠错**只依据真实报错**修，不得顺手扩大改动范围。 |
| 6 | 本项目的头号结构缺陷是**多跳 join 漏中间表**（规则 `t_bid_record → t_section → t_project → t_region` 四级链路最易漏 `t_section`），示例见 §4.1。 |

---

## 1. 模板全文（可直接复制粘贴进代码）

### 1.1 分支 A：事前自审（`mode = pre_check`）

```text
# ============ 系统指令 ============
你是系统的 SQL 审查助手。你的任务是：在 SQL 执行之前，对它做一次**结构性自审**，只找出会导致「执行失败 / 越权 / 结果错误」的确定性缺陷，并给出最小修正。

## 审查边界（严格遵守）
1. 你**只能修正结构性缺陷**，绝不能改变查询的业务语义（如本来查中标金额，不能改成查投标数量；不能增删过滤条件改变结果口径）。
2. 你只依据下方提供的「元数据」和「程序校验报错」判断，不得引入元数据外的表/字段。
3. 若 SQL 没有问题，返回 verdict = "ok"，fixed_sql = null。
4. 若发现缺陷但**无法在不改变语义的前提下确定修法**（例如缺少必要口径信息），返回 verdict = "need_clarification"，不要强行修改。

## 必须检查的 6 类问题（逐一核查）
1. 【只读合规】是否只含单条 SELECT？是否出现 INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE 或分号多语句？（任何写操作 → verdict = "reject"）
2. 【方言正确】标识符引用符（mysql 反引号 / postgresql 双引号）、日期函数、LIMIT 语法是否与目标方言一致？
3. 【join 完整】多表查询时，是否每张表都被正确 join（无笛卡尔积 / 无孤立表）？join 条件是否来自给定表关系？**特别注意多跳链路：必须逐跳经过中间表，不得跨表直接 join 一个本表没有的字段。**
4. 【聚合完整】SELECT 中的非聚合列是否都出现在 GROUP BY 中？有聚合但缺 GROUP BY 是否合理？
5. 【时间边界】时间范围是否明确、端点是否合理（推荐左闭右开 `>= 起 AND < 止`）？相对时间是否已换算为具体日期？
6. 【NULL 处理】对可能为 NULL 的字段，聚合/比较/join 是否需要 COALESCE / IS NULL / 空值防护？排序时是否需要排除 NULL？

## 输出约束
- 只输出一个 JSON 对象，不要输出 JSON 以外的文字或 Markdown 代码块。
- fixed_sql 必须是**完整可执行**的单条 SELECT（不是 diff、不是片段）。

# ============ 输入 ============
## 目标方言
{{dialect}}

## 元数据（DDL + 表关系 + 术语）
{{schema_context}}
{{relation_block}}
{{terms_context}}

## 待审查 SQL
{{sql_text}}

## 程序（F-12）校验报错（若无则为空）
{{validation_errors}}

# ============ 输出要求 ============
输出 JSON：

{
  "verdict": "ok | needs_fix | reject | need_clarification",
  "issues": [
    {
      "type": "readonly | dialect | join | group_by | time_boundary | null_handling",
      "severity": "high | medium | low",
      "description": "问题描述（中文）",
      "evidence": "在 SQL 中的位置或依据"
    }
  ],
  "fixed_sql": "修正后的完整单条 SELECT；verdict=ok 时为 null",
  "explanation": "修改说明：改了什么、为什么（中文，简洁）"
}

## verdict 取值规则
- "ok"：无问题，SQL 可直接执行。
- "needs_fix"：存在可确定修正的结构性缺陷，已给 fixed_sql。
- "reject"：存在写操作/多语句等只读违规，必须作废重生成，fixed_sql = null。
- "need_clarification"：发现缺陷但修法依赖未知口径，无法安全修正，fixed_sql = null。
```

### 1.2 分支 B：事后纠错（`mode = post_error`）

```text
# ============ 系统指令 ============
你是系统的 SQL 修复助手。上一步生成的 SQL 在数据库执行时报错了。你的任务是：依据**数据库返回的真实错误信息**，重写这条 SQL 使其可执行且语义不变。

## 修复边界（严格遵守）
1. 只修**导致报错的直接原因**，不做与报错无关的优化或改写（避免引入新错误）。
2. 你只能使用下方「元数据」中存在的表名、字段名；若报错表明使用了不存在字段，改为元数据中的正确字段；若元数据中无合适字段，返回 need_clarification。
3. 保持原查询的业务意图（统计口径、时间范围、分组维度）不变。
4. 输出必须是**完整、可直接执行的单条 SELECT**。

## 常见报错的处理原则
- Unknown column / 字段不存在：核对元数据字段名，改用正确字段（注意大小写与别名）。
- Ambiguous column / 字段歧义：为字段加上表别名前缀。
- Table doesn't exist / 表不存在：核对元数据表名；若不在授权范围，返回 reject。
- 语法错误（Syntax error）：按目标方言修正语法（引用符、函数、逗号、括号）。
- 函数不存在 / 类型不匹配：改用目标方言支持的等价函数或做类型转换。
- GROUP BY 相关：补齐 GROUP BY 或调整聚合。

## 只读红线
不得借修复之机引入 INSERT/UPDATE/DELETE/DDL 或多语句；任何写操作一律 reject。

## 输出约束
- 只输出一个 JSON 对象，不要输出 JSON 以外的文字或 Markdown 代码块。

# ============ 输入 ============
## 目标方言
{{dialect}}

## 元数据（DDL + 表关系 + 术语）
{{schema_context}}
{{relation_block}}
{{terms_context}}

## 当前 SQL
{{sql_text}}

## 数据库返回的错误信息
{{db_error}}

## 重试状态
已重试次数：{{retry_count}}；上限：{{max_retry}}（硬上限 2）
历史尝试摘要：{{attempt_history}}

## 若已达上限
当 {{retry_count}} >= {{max_retry}} 时，不要返回 fixed_sql，必须返回 verdict = "give_up"。

# ============ 输出要求 ============
输出 JSON：

{
  "verdict": "fixed | need_clarification | reject | give_up",
  "issues": [
    {
      "type": "unknown_column | ambiguous_column | unknown_table | syntax | function_type | group_by | other",
      "severity": "high | medium | low",
      "description": "根据报错定位到的问题（中文）",
      "evidence": "数据库报错原文关键片段"
    }
  ],
  "fixed_sql": "修正后的完整单条 SELECT；未修复时为 null",
  "explanation": "修改说明：报错原因 + 修复方式（中文，简洁）"
}

## verdict 取值规则
- "fixed"：已给出可执行修正，fixed_sql 有效。
- "need_clarification"：报错源于业务口径缺失（如元数据无对应字段），需询问用户，fixed_sql = null。
- "reject"：错误涉及越权/写操作，作废，fixed_sql = null。
- "give_up"：已达重试上限，fixed_sql = null。
```

---

## 2. 变量说明表

| 变量名 | 类型 | 来源 | 必填 | 示例值 | 缺失降级 |
|---|---|---|---|---|---|
| `{{mode}}` | enum | 调用方 | 是 | `pre_check` / `post_error` | 缺失 → 报错不调用 |
| `{{dialect}}` | enum | 数据源 | 是 | `mysql` | 缺失 → 中止 |
| `{{sql_text}}` | string | 生成结果 | 是 | `SELECT ...` | 缺失 → 中止 |
| `{{schema_context}}` / `{{relation_block}}` / `{{terms_context}}` | string | 元数据 | 元数据分区必填 | 同模板 01 | 空 → 仅做语法/只读层判断 |
| `{{validation_errors}}` | json | F-12 校验器 | pre_check 必填 | `[{"type":"ambiguous_column","column":"c_id"}]` | 空 → 仅做语义自查 |
| `{{db_error}}` | string | 数据库 | post_error 必填 | `ERROR 1052 (23000): Column 'c_id' in field list is ambiguous` | 缺失 → 中止（无法纠错） |
| `{{retry_count}}` | int | 执行服务 | 是 | `1` | 缺失 → 按 0 处理并告警 |
| `{{max_retry}}` | int | 配置（硬上限 2） | 是 | `2` | 缺失 → 强制 2 |
| `{{attempt_history}}` | string | 执行服务 | 否 | 前次 SQL + 报错摘要 | 空 → 无历史提示 |

---

## 3. 使用说明（何时调用 / 调用参数）

| 项 | 说明 |
|---|---|
| 分支 A 调用时机 | 主生成（模板 01）产出 SQL 且**已通过 F-12** 之后、执行之前；建议仅对「多表 join / 聚合 / 时间范围」类问题触发以省延迟（[待确认]） |
| 分支 B 调用时机 | 执行报错（F-13）后立即触发 |
| 调用次数 | 分支 A 每次生成 ≤1 次；分支 B 每次问答 **≤2 次**（与模板 01 的生成重试共用计数上限） |
| **强制流程（不可跳过）** | `fixed_sql` 产出后 → **必须重跑 F-12 校验** → 通过才执行；不通过则计入下一次重试 |
| 循环保护 | 程序维护 `retry_count`；`retry_count >= max_retry` 时，分支 B 直接传 `retry_count>=max_retry`，模板返回 `give_up`，前端提示人工介入 |

### 3.1 重试状态机

```
生成(N=0) ──F-12通过──► [pre_check] ──ok──► 执行
   ▲                        │needs_fix
   │                        ▼
   │                    fixed_sql ──► 重跑F-12 ──通过──► 执行
   │                        │不通过 / 执行报错
   │                        ▼
   └──────────── N++ ──[post_error] ──fixed──► 重跑F-12 ──► 执行
                          │ N>=2
                          ▼
                       give_up → 人工介入
```

---

## 4. 示例

> 均基于 `tests/golden/00-示例Schema-招投标业务.md`。四级区域链路：`t_bid_record.sec_no → t_section.sec_no → t_section.prj_no → t_project.prj_no → t_project.region_cd → t_region.reg_cd`。

### 4.1 示例 A（事前自审）：漏中间表 join / 漏 group by

**输入**
```text
dialect: mysql
sql_text:
SELECT p.region_cd, SUM(b.bid_price) AS won_amt
FROM t_bid_record b
JOIN t_project p ON b.prj_no = p.prj_no
WHERE b.rst = 2
GROUP BY p.region_cd;
validation_errors: []
```
（元数据：`t_bid_record` **没有 `prj_no` 字段**；到项目须经 `t_section`：`t_bid_record.sec_no = t_section.sec_no`，`t_section.prj_no = t_project.prj_no`。）

**期望输出**
```json
{
  "verdict": "needs_fix",
  "issues": [
    {
      "type": "join",
      "severity": "high",
      "description": "t_bid_record 表没有 prj_no 字段，不能直接 join t_project；到项目必须经过标段表 t_section 中转，否则执行必然报 Unknown column。",
      "evidence": "JOIN t_project p ON b.prj_no = p.prj_no，而 b(即 t_bid_record) 无 prj_no 列"
    }
  ],
  "fixed_sql": "SELECT p.region_cd, SUM(b.bid_price) AS won_amt FROM t_bid_record b JOIN t_section s ON b.sec_no = s.sec_no JOIN t_project p ON s.prj_no = p.prj_no WHERE b.rst = 2 GROUP BY p.region_cd",
  "explanation": "按表关系补齐多跳链路：t_bid_record.sec_no → t_section.sec_no，再 t_section.prj_no → t_project.prj_no。原 SQL 跨表直接引用了本表不存在的 prj_no，属链条漏跳。业务口径（中标金额 bid_price、rst=2、按区域分组）未改变。"
}
```

### 4.2 示例 B（事后纠错）：拿到真实报错后修正（歧义列名）

**输入**
```text
dialect: mysql
sql_text:
SELECT c_id, mgr_nm, bid_price
FROM t_bid_record b
JOIN t_company c ON b.c_id = c.c_id
JOIN t_manager m ON b.mgr_id = m.mgr_id
WHERE b.rst = '2';
db_error: ERROR 1052 (23000): Column 'c_id' in field list is ambiguous
retry_count: 1
max_retry: 2
attempt_history: 第1次尝试: 报错同上
```

**期望输出**
```json
{
  "verdict": "fixed",
  "issues": [
    {
      "type": "ambiguous_column",
      "severity": "high",
      "description": "SELECT 中的 c_id 同时存在于 t_bid_record 与 t_company，未加表别名前缀导致歧义报错。",
      "evidence": "ERROR 1052 (23000): Column 'c_id' in field list is ambiguous"
    }
  ],
  "fixed_sql": "SELECT b.c_id, m.mgr_nm, b.bid_price FROM t_bid_record b JOIN t_company c ON b.c_id = c.c_id JOIN t_manager m ON b.mgr_id = m.mgr_id WHERE b.rst = '2'",
  "explanation": "为歧义字段 c_id 加上表别名前缀 b.（取投标记录上的企业编号，语义与原意一致）；同时对同表的 bid_price 一并加前缀以避免潜在歧义。业务口径不变。"
}
```

### 4.3 示例 C（事后纠错·达上限）：返回 give_up

**输入**：`retry_count: 2, max_retry: 2`，SQL 仍报 `Unknown column 'won_amt2'`

**期望输出**
```json
{
  "verdict": "give_up",
  "issues": [
    {
      "type": "unknown_column",
      "severity": "high",
      "description": "元数据中不存在 won_amt2 字段，且无法在不改变语义的前提下确定替代字段。",
      "evidence": "ERROR 1054: Unknown column 'won_amt2'；已重试 2 次达上限"
    }
  ],
  "fixed_sql": null,
  "explanation": "已达最大重试次数（2 次），且问题根因是元数据缺失口径而非语法错误，继续重试无意义，转人工处理。"
}
```

---

## 5. 已知边界与失败模式

| 失败模式 | 现象 | 缓解 |
|---|---|---|
| 自审越界改语义 | 事前自审顺手改了过滤条件 | 模板硬约束「不改语义」+ issues 须标注 type，程序可审查 diff |
| 漏跳未检出 | 多跳链路（如缺 t_section）未被发现，仍执行报错 | 检查项 3 显式要求「逐跳经中间表」+ 关系分区提供完整链路 |
| 无限重试 | 程序未强制计数 | `retry_count`/`max_retry` 由程序维护，模板只读；达上限强制 give_up |
| 跳过重校验 | 直接执行 fixed_sql | **PRD §8.4 红线**：程序层强制 fixed_sql 必过 F-12 才可执行 |
| 纠错引入写操作 | 借修复注入 DELETE | 模板只读红线 + F-12 二次拦截（双保险） |
| 报错信息缺失 | 只给通用报错 | 缺失 `{{db_error}}` 时不调用分支 B，直接提示人工 |
| 修错方向 | 改错字段导致结果错 | 修复后重跑回归集抽样验证（评估方案 §3） |

---

## 6. [待确认]

| # | 项 | 建议默认 |
|---|---|---|
| 1 | 事前自审是否默认开启 | 仅多表 join / 聚合类触发 |
| 2 | 生成重试与纠错重试是否共用同一计数器 | 建议共用，总上限 2 |
| 3 | `give_up` 后是否给用户「手动编辑 SQL 重试」入口 | 建议提供（P-07 「报告错误」已在设计中） |
| 4 | 报错信息是否清洗（去掉库名/主机等敏感信息）后再回灌 | 建议清洗，避免信息泄露到日志 |
