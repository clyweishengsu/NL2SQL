# NL2SQL 本地工作台

一个通用的自然语言转 SQL 本地应用。用户连接自己的 MySQL 数据库，筛选允许问数的表，配置业务元数据和表关系，再通过 OpenAI 兼容模型生成只读 SQL、审核并执行查询。

## 主要能力

- MySQL 连接及真实 Schema 读取
- 可参与问数的库表范围筛选
- 表、字段、关系和明细查询元数据配置
- AI 辅助生成元数据草稿
- 大表集合的相关表召回
- 自然语言生成 MySQL 只读 SQL
- SQL AST 校验、失败修复和敏感字段保护
- 查询限时及最多 200 行结果限制
- Windows x64 便携版构建，无需最终用户安装 Python

## Windows 便携版

便携版最终用户无需安装 Python、Node.js 或 MySQL 客户端。解压完整目录后运行 `NL2SQL本地工作台.exe`。

便携包不会包含开发机的数据库配置。用户配置保存在：

```text
%LOCALAPPDATA%\NL2SQLWorkbench\data
```

MySQL 密码和模型 API Key 只保存在当前进程内存，重启后需要重新输入。

## 源码运行

需要 Python 3.9 或更高版本：

```powershell
python -m pip install -r requirements.txt
python local_app/server.py
```

应用会打开：<http://127.0.0.1:8765/>

## 构建 Windows 便携包

```powershell
python -m pip install -r requirements-build.txt
powershell -ExecutionPolicy Bypass -File .\build-windows-portable.ps1
```

输出文件：

```text
dist\NL2SQL-Workbench-Windows-x64.zip
```

## 使用流程

1. 在“数据库与库表导入”连接 MySQL，只使用具有 SELECT 权限的账号。
2. 读取 Schema，勾选并保存允许参与问数的表。
3. 在“元数据配置”补充表业务名、字段解释、表关系和明细查询默认设置。
4. 在“模型配置”填写 OpenAI 兼容接口地址、模型名称和 API Key。
5. 在“问数台”输入问题，生成并审核 SQL，然后执行只读查询。

## 安全边界

- 服务只监听 `127.0.0.1`。
- 未纳入范围的表不能查询。
- 敏感字段不会发送给模型，也不能出现在查询中。
- 只允许单条只读 SELECT，可使用只读 CTE 和子查询。
- 问题及相关库表元数据会发送给用户配置的模型服务，查询结果行不会发送给模型。
- 当前是单机应用，不包含多用户登录和数据库行级权限。

## 测试

```powershell
python -m unittest discover -s local_app/tests -v
```

当前后端测试共 21 项。

## 项目结构

```text
local_app/                  应用后端、前端和测试
prompts/                    Prompt 设计文档
windows-portable.spec       PyInstaller 构建配置
build-windows-portable.ps1  Windows 便携版构建脚本
requirements.txt            运行依赖
requirements-build.txt      构建依赖
```

更完整的运行说明见 [`local_app/README.md`](local_app/README.md)。
