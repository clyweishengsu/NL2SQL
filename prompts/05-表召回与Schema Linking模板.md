# 模板 05：表召回与 Schema Linking 模板

> 文件：`prompts/05-表召回与Schema Linking模板.md`
> 版本：v1.1.0 ｜ 产出人：文达意 ｜ 日期：2026-09
> 对应功能：**F-21 表召回（Schema Linking）**
> 上游依据：`docs/PRD-自然语言转SQL.md` §8.3（召回策略）、验收 §2 F-21「仅将 Top-N 相关表注入上下文，Token 不超预算」「自动补入关联表」
> **示例 Schema 底座**：`tests/golden/00-示例Schema-招投标业务.md`（7 表，全项目唯一）
> 消费方：生成服务（@dev 集成）；召回详情写入 `recall_trace` 供 P-08 调试页

---

## 0. 核心结论（先看这里）

| # | 结论 |
|---|---|
| 1 | **分工明确**：向量检索负责「广召回」（Top-N=15，低成本、高召回率），LLM 复排负责「精排 + 收敛」（Top-N → 最终 6~8 张，剔除噪声、补 join 路径）。 |
| 2 | LLM **只做选择与判断，不做发明**：候选表由向量检索给出；LLM 只能从候选清单+关系索引中挑选与补全，不得引入清单外的表。 |
| 3 | **关系补全**是召回的必备环节：本项目最典型的是四级区域链路 `t_bid_record → t_section → t_project → t_region`，中间表 `t_section`/`t_project` 常不被向量直接命中，必须靠关系补全注入。 |
| 4 | **空召回保护**：候选与问题均不相关时返回空并提示「未找到相关数据表」，不硬凑（验收 F-21 边界）。 |
| 5 | 本模板**不参与** ≤200 表场景（小库直接全量注入更稳，避免召回引入漏表风险）。 |

---

## 1. 模板全文（可直接复制粘贴进代码）

```text
# ============ 系统指令 ============
你是系统的数据表筛选助手。数据库中表很多，不能全部塞进上下文。你的任务：根据用户的问题，从下方**候选表清单**中选出回答问题真正需要的表，并补全为能正确 join 的最小表集合。

## 严格边界
1. 你**只能从「候选表清单」和「关系索引」中选择表**。不得引入清单之外的表名，不得凭想象编造表。
2. 宁可少选，不要多选：与问题无关的表会稀释上下文、降低生成准确率。
3. 若问题需要多表关联，必须把所有中间关联表一并选出，保证 join 路径连通。**尤其是多跳链路：不能跳过中间表直接关联两张无直接关系的表。**
4. 若候选表中没有任何表与问题相关，返回 relevant_tables = []、need_more = "none"，并在 reason 中说明。
5. 若候选表不足以回答问题（例如缺少明显必需的一张表），返回 need_more = "expand"，说明还缺什么类型的表。

## 选择依据（按优先级）
① 表业务解释与用户问题的语义匹配度；
② 关键字段是否覆盖问题中的实体（金额、时间、状态、地区、企业、资质等）；
③ 向量相似度分（仅作参考，不作为唯一依据，可能被字面相似误导）；
④ 表之间的关系连通性（能否形成完整 join 路径）。

# ============ 输入 ============
## 用户问题
<<<USER_QUESTION_START>>>
{{user_question}}
<<<USER_QUESTION_END>>>

## 候选表清单（共 {{recall_top_n}} 张，按向量相似度降序）
{{table_candidates}}

## 关系索引（候选表之间的关系子集）
{{relation_index}}

## 收敛目标
最终保留表数量上限：{{final_n}}（若必需表超过该上限，请按重要性排序并说明理由）

# ============ 输出要求 ============
只输出一个 JSON 对象，不要输出 JSON 以外的文字或 Markdown 代码块：

{
  "relevant_tables": [
    {
      "table_name": "表名",
      "role": "主体表 | 关联表 | 字典表",
      "selected_by": "vector | relation_补全",
      "reason": "选择理由（中文，一句话，说明它与问题的关系）",
      "score": 0.0
    }
  ],
  "relation_path": [
    "t_bid_record.sec_no = t_section.sec_no"
  ],
  "need_more": "none | expand",
  "expand_hint": "当 need_more=expand 时，说明还缺少什么表（中文）；否则为 null",
  "confidence": 0.0
}

## 规则
- selected_by 标注了该表是"向量检索直接命中"还是"为补全 join 路径而补入"，便于调试页展示。
- relation_path 列出所选表之间实际会用到的 join 条件，必须来自「关系索引」，不要编造。
- confidence 为 0~1，表示你对本次召回结果的信心。
```

---

## 2. 变量说明表

| 变量名 | 类型 | 来源 | 必填 | 示例值 | 缺失降级 |
|---|---|---|---|---|---|
| `{{user_question}}` | string | 用户输入 | 是 | `2025 年各地区中标金额最高的企业及其资质等级` | 缺失 → 不调用 |
| `{{table_candidates}}` | string | 向量检索 Top-N | 是 | 见 §4.1 | 空 → 提示「未找到相关数据表」 |
| `{{relation_index}}` | string | 表关系（F-17） | 否 | 候选表间关系子集 | 空 → 无法补全 join，confidence 上限 0.6 |
| `{{recall_top_n}}` | int | 配置（默认 15） | 是 | `15` | 缺失 → 默认 15 |
| `{{final_n}}` | int | 配置（默认 6~8） | 是 | `6` | 缺失 → 默认 6 |

> **候选表渲染格式（dev 按此生成 `{{table_candidates}}`）**：
> `表名 | 表业务名 | 表解释（≤60字） | 关键字段（业务名:类型，≤8个） | 向量分`
> 每张表一行。候选总 token 建议 ≤ 3000。

---

## 3. 使用说明（向量 vs LLM 的分工）

### 3.1 两步分工

| 步骤 | 执行者 | 输入 | 输出 | 目的 | 成本 |
|---|---|---|---|---|---|
| ① 广召回 | **向量检索**（对「表业务名+表解释+字段业务名/描述+术语+示例」建立索引） | 用户问题 | Top-N=15 候选表 + 相似度分 | 高召回率、快速缩小范围 | 低（毫秒级） |
| ② 精排 + 补全 | **LLM（本模板）** | 候选表清单 + 关系索引 + 问题 | 最终 6~8 张表 + join 路径 | 去噪、保 join 连通、补充中间表 | 1 次 LLM |

### 3.2 Top-N → 最终 N 的收敛规则

```
1. 向量召回 Top-N（N=15）：保证召回率（宁可多召回）。
2. 字段级线索补充：若问题中出现"金额/时间/状态/地区/资质"等实体词，
   对命中表的字段做二次向量匹配，把关键字段所在表也纳入候选（可选）。
3. LLM 精排（本模板）：Top-15 → 保留主体表 + 必需关联表，
   目标 final_n（默认 6），按 reason 重要性排序。
4. 关系补全：若主体表之间无直连关系，自动沿关系索引补入中间表。
   （本项目：t_bid_record 到 t_region 必须补 t_section、t_project）
5. 兜底：若 LLM 输出表数 > final_n，程序按 confidence 与 role 截断，并保留所有 role=主体表 的表。
```

### 3.3 调用参数

| 项 | 说明 |
|---|---|
| 调用时机 | **仅当数据域表数 > 200** 时（PRD §8.3）；≤200 表直接全量注入 |
| 调用次数 | 每次问答 1 次；对相同问题可缓存 |
| 模型参数 | `temperature=0.0`、`max_tokens=1024` |
| 结果处理 | 输出表集合 → 渲染为 `{{ddl_block}}`/`{{table_doc_block}}`/`{{column_desc_block}}` 供模板 01 使用；`recall_trace` 写入调试页 |

---

## 4. 完整示例（20 张候选 → 选出 4 张 + 关系补全 2 张）

> 候选清单由「`tests/golden/00-示例Schema` 的 7 张真实表」+「13 张演示用噪声表（来自其它业务域，用于模拟大库）」构成，共 20 张。

### 4.1 输入

```text
user_question: 2025 年各地区中标金额最高的企业是哪些？顺便给出它们的资质等级。

候选表清单（共 20 张，按向量相似度降序，节选 10 张）
t_bid_record     | 投标记录表   | 核心事实表，一条记录=某企业对某标段的一次投标 | 投标报价:decimal, 投标结果:tinyint, 投标日期:date | 0.92
t_region         | 地区字典表   | 区域编码与名称                              | 地区编码:varchar, 地区名称:varchar | 0.71
t_company        | 投标企业表   | 投标企业主数据，含类型、注册资本            | 企业编号:varchar, 企业名称:varchar, 企业类型:tinyint | 0.68
t_company_qual   | 企业资质表   | 一企多资质                                  | 资质名称:varchar, 资质等级:varchar | 0.63
t_project        | 招标项目表   | 项目主数据，含所属地区编码                  | 项目编号:varchar, 地区编码:varchar, 预算金额:decimal | 0.55
t_section        | 标段表       | 一个项目下的标段，含限价与开标时间          | 标段编号:varchar, 项目编号:varchar, 最高投标限价:decimal | 0.49
t_manager        | 项目经理表   | 人员主数据                                  | 人员编号:varchar, 姓名:varchar, 联系电话:varchar | 0.34
t_staff_attend   | 员工考勤记录 | 员工每日打卡记录（其它业务域）              | 员工编号:varchar, 打卡时间:datetime | 0.21
t_invoice        | 发票台账     | 采购发票记录（其它业务域）                  | 发票号:varchar, 含税金额:decimal | 0.18
t_dept           | 部门表       | 组织部门字典（其它业务域）                  | 部门编号:varchar, 部门名称:varchar | 0.12
（其余 10 张为更低的噪声表，略）

关系索引
t_bid_record.sec_no = t_section.sec_no (N:1)
t_section.prj_no = t_project.prj_no (N:1)
t_project.region_cd = t_region.reg_cd (N:1)
t_bid_record.c_id = t_company.c_id (N:1)
t_company_qual.c_id = t_company.c_id (N:1)
t_bid_record.mgr_id = t_manager.mgr_id (N:1)

收敛目标 final_n: 6
```

### 4.2 期望输出

```json
{
  "relevant_tables": [
    {
      "table_name": "t_bid_record",
      "role": "主体表",
      "selected_by": "vector",
      "reason": "中标金额与投标结果(rst)均在此表，是统计的主体。",
      "score": 0.92
    },
    {
      "table_name": "t_region",
      "role": "字典表",
      "selected_by": "vector",
      "reason": "『各地区』需要按规范地区分组并显示地区名称。",
      "score": 0.71
    },
    {
      "table_name": "t_company",
      "role": "关联表",
      "selected_by": "vector",
      "reason": "『企业』需要企业名称，且资质挂在企业上。",
      "score": 0.68
    },
    {
      "table_name": "t_company_qual",
      "role": "关联表",
      "selected_by": "vector",
      "reason": "『资质等级』字段在资质表中。",
      "score": 0.63
    },
    {
      "table_name": "t_section",
      "role": "关联表",
      "selected_by": "relation_补全",
      "reason": "t_bid_record 到项目之间必须经标段表中转，否则无法到达地区，属必需中间表。",
      "score": 0.49
    },
    {
      "table_name": "t_project",
      "role": "关联表",
      "selected_by": "relation_补全",
      "reason": "地区编码在项目表上，是区域链路的必需中间表。",
      "score": 0.55
    }
  ],
  "relation_path": [
    "t_bid_record.sec_no = t_section.sec_no",
    "t_section.prj_no = t_project.prj_no",
    "t_project.region_cd = t_region.reg_cd",
    "t_bid_record.c_id = t_company.c_id",
    "t_company_qual.c_id = t_company.c_id"
  ],
  "need_more": "none",
  "expand_hint": null,
  "confidence": 0.84
}
```

> **说明**：
> ① 命中 4 张（`t_bid_record`/`t_region`/`t_company`/`t_company_qual`，向量分 ≥0.63）；
> ② **关系补全 2 张**（`t_section`/`t_project`）——它们向量分不高（0.49/0.55），
>    但缺了它们就无法从投标记录走到地区，是**四级区域链路的必需中间表**；
> ③ `t_manager`（0.34）、`t_staff_attend`（0.21）、`t_invoice`（0.18）、`t_dept`（0.12）与本问题无关，**主动剔除**；
> ④ 最终 6 张 = `final_n` 上限，未超。

---

## 5. 已知边界与失败模式

| 失败模式 | 现象 | 缓解 |
|---|---|---|
| 漏召回关键表 | 向量未命中必需表 → join 失败 | 提高 Top-N；字段级线索补充；**关系补全** |
| 漏补中间表 | 只选 `t_bid_record`+`t_region`，缺 `t_section`/`t_project` → 无法 join | 模板「多跳不得跳过中间表」+ 程序按关系索引自动闭包补全 |
| 字面相似误导 | 名字像但语义无关的表被选（如 `t_invoice.含税金额`） | LLM 精排以「表解释」为主依据，向量分仅参考 |
| 多选噪声 | 把无关表也选进来 | 模板「宁少勿多」+ final_n 上限 + 程序截断 |
| 编造表名 | 输出候选清单外的表 | 模板硬约束 + 程序校验（输出表必须 ⊆ 候选集） |
| 关系不存在 | relation_path 用了索引外条件 | 模板约束 + 程序比对关系索引 |
| 空召回硬凑 | 问题与表无关却返回表 | need_more=none 且 relevant_tables=[] 分支 + 前端提示 |

---

## 6. [待确认]

| # | 项 | 建议默认 |
|---|---|---|
| 1 | Top-N 与 final_n 最终取值 | N=15、final_n=6（PRD §12 建议 N=15） |
| 2 | 是否对命中表做字段级二次检索 | 建议启用（提升关键字段命中） |
| 3 | 关系补全是否由程序强制闭包（不完全依赖 LLM） | **建议程序强制**：对 LLM 输出再做一次关系闭包，确保链路连通 |
| 4 | 召回结果是否缓存 | 建议按问题指纹缓存，5 分钟有效 |

---

## 变更记录

| 日期 | 版本 | 人 | 内容 |
|---|---|---|---|
| 2026-09 | v1.0.0 | 文达意 | 首版：向量/LLM 分工、收敛规则、候选渲染格式、20→4 示例 |
| 2026-09 | v1.1.0 | 文达意 | 对齐 `tests/golden/00-示例Schema`：示例改为 7 张真实表 + 噪声表；示例体现四级链路中间表（t_section/t_project）必须关系补全；新增「程序强制关系闭包」待确认项 |
