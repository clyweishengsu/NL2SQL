/* 本地真实工作台。视觉沿用原 HTML，数据、模型和 SQL 全部走本地服务。 */
const app = {
  view: 'ask', sources: [], sourceId: '', schema: [], meta: null, draft: null,
  selectedTable: '', scopeDraft: new Set(), tableFilter: '', metaTab: 'table', metaFilter: '', metaStatus: 'all',
  relationFromTable: '', relationToTable: '', model: {}, messages: [], busy: false, submitting: false,
  pendingQuestion: '',
};
const initialView = new URLSearchParams(location.search).get('view');
if (['ask', 'sources', 'metadata', 'model'].includes(initialView)) app.view = initialView;
const initialMetaTab = new URLSearchParams(location.search).get('tab');
if (['table', 'columns', 'relations', 'query'].includes(initialMetaTab)) app.metaTab = initialMetaTab;

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function request(path, method = 'GET', body) {
  const opts = { method, headers: { 'X-Local-App': '1' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let response;
  try { response = await fetch(path, opts); }
  catch { throw new Error('无法连接本地服务，请确认启动窗口仍在运行'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('本地服务返回了无法解析的响应'); }
  if (!response.ok) throw new Error(data.error || `请求失败：HTTP ${response.status}`);
  return data;
}

async function refreshStatus(preferredSource) {
  const previousSourceId = app.sourceId;
  const data = await request('/api/status');
  app.sources = data.sources;
  app.model = data.model;
  if (preferredSource && app.sources.some(s => s.id === preferredSource)) app.sourceId = preferredSource;
  if (!app.sources.some(s => s.id === app.sourceId)) app.sourceId = app.sources[0]?.id || '';
  if (previousSourceId && previousSourceId !== app.sourceId) {
    app.messages = [];
    app.pendingQuestion = '';
  }
  const selected = app.sources.find(s => s.id === app.sourceId);
  if (selected && !selected.connected) {
    app.schema = []; app.meta = selected; app.draft = JSON.parse(JSON.stringify(selected));
    app.scopeDraft = new Set(selected.included_tables || []);
  } else if (app.sourceId) await loadSchema(false);
  else { app.schema = []; app.meta = null; app.draft = null; }
  render();
}

async function loadSchema(shouldRender = true) {
  if (!app.sourceId) return;
  const sourceId = app.sourceId;
  const data = await request(`/api/schema?source_id=${encodeURIComponent(sourceId)}`);
  if (app.sourceId !== sourceId) return;
  app.schema = data.tables;
  app.meta = data.source;
  app.draft = JSON.parse(JSON.stringify(data.source));
  app.scopeDraft = new Set(data.source.included_tables || []);
  const included = includedTables();
  prefillTableBusinessNames(app.draft, included);
  if (!included.some(t => t.name === app.selectedTable)) app.selectedTable = included[0]?.name || '';
  if (shouldRender) render();
}

function includedTables() {
  if (app.meta?.type !== 'mysql') return app.schema;
  const names = new Set(app.meta?.included_tables || []);
  return app.schema.filter(table => names.has(table.name));
}

function canOpenMetadata() {
  const active = app.sources.find(s => s.id === app.sourceId);
  return Boolean(active?.connected && includedTables().length);
}

function prefillTableBusinessNames(source, tables) {
  if (!source) return;
  source.table_business_names ||= {};
  for (const table of tables) {
    const comment = (table.native_comment || '').trim();
    if (!source.table_business_names[table.name] && comment && comment.length <= 40) {
      source.table_business_names[table.name] = comment;
    }
  }
}

function render() {
  if (app.view === 'metadata' && !canOpenMetadata()) app.view = 'sources';
  const active = app.sources.find(s => s.id === app.sourceId);
  const navigation = [
    ['ask', '问数台', '◫'], ['sources', '数据库与库表导入', '▤'],
    ['metadata', '元数据配置', '◇'], ['model', '模型配置', '⚙'],
  ];
  $('#app').innerHTML = `
    <div class="topbar">
      <div class="brand"><span class="logo">NL</span>自然语言转 SQL</div>
      <div class="topnav">${navigation.map(([id, label]) =>
        `<button class="${app.view === id ? 'active' : ''} ${id === 'metadata' && !canOpenMetadata() ? 'locked' : ''}"
          data-view="${id}" aria-disabled="${id === 'metadata' && !canOpenMetadata()}">${label}</button>`).join('')}</div>
      <div class="topbar-right">
        <span class="badge ${app.model.configured ? 'ok' : 'warn'}">${app.model.configured ? '模型已配置' : '等待配置模型'}</span>
        <span>数据源</span><select class="domain-sel live-source-select" data-source-switch>
          ${app.sources.length ? app.sources.map(s => `<option value="${esc(s.id)}" ${s.id === app.sourceId ? 'selected' : ''}>${esc(s.name)}</option>`).join('') : '<option value="">尚未连接</option>'}
        </select>
      </div>
    </div>
    <div class="layout">
      <nav class="sidenav">
        ${navigation.map(([id, label, icon]) => `<div class="nav-item ${app.view === id ? 'active' : ''} ${id === 'metadata' && !canOpenMetadata() ? 'locked' : ''}"
          data-view="${id}" aria-disabled="${id === 'metadata' && !canOpenMetadata()}"><span class="ic">${icon}</span>${label}</div>`).join('')}
        <div class="nav-sep"></div>
        <div class="nav-group-title">当前工作区</div>
        <div style="padding:4px 12px" class="live-note">
          <strong>${esc(active?.name || '未选择数据源')}</strong><br>
          已选 ${includedTables().length} / ${app.schema.length} 张表 · ${active?.type === 'mysql' ? 'MySQL' : 'SQLite'}<br>
          本地服务真实执行<br>
          结果最多 200 行
        </div>
        <div class="nav-sep"></div>
        <div class="nav-group-title">使用方式</div>
        <div style="padding:4px 12px" class="live-note">连接 MySQL → 读取并筛选库表 → 配置业务口径 → 连接模型 → 提问并执行 SQL</div>
      </nav>
      <main class="main">${app.view === 'ask' ? renderAsk() : app.view === 'sources' ? renderSources()
        : app.view === 'metadata' ? renderMetadataPage() : renderModel()}</main>
    </div>`;
  if (app.view === 'ask') {
    const chat = $('#live-chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
  } else if (app.view === 'sources') updateScopeSummary();
}

function renderAsk() {
  const active = app.sources.find(s => s.id === app.sourceId);
  const chosenTables = includedTables();
  const databaseStatus = !active ? '数据库未配置：请先到“数据库与库表导入”连接 MySQL。'
    : !active.connected ? '数据库未连接：请到“数据库与库表导入”重新输入密码。'
    : !chosenTables.length ? '数据库已连接，尚未导入库表：请筛选并保存问数范围。'
    : `数据库已配置：已导入 ${chosenTables.length} 张表。`;
  const last = [...app.messages].reverse().find(m => m.role === 'assistant' && m.sql);
  return `
    <div class="page-head"><div><h1>问数台</h1><div class="sub">基于当前数据库结构和业务配置生成 SQL，由你确认后在本地只读执行</div></div>
      <div class="right"><button class="btn btn-sm" data-clear-chat>清空对话</button></div></div>
    <div class="live-steps">
      <span class="${app.sourceId && active?.connected ? 'done' : 'current'}">1 连接 MySQL</span>
      <span class="${chosenTables.length ? 'done' : active?.connected ? 'current' : ''}">2 筛选库表</span>
      <span class="${app.model.configured ? 'done' : chosenTables.length ? 'current' : ''}">3 连接模型</span>
      <span class="${app.model.configured && chosenTables.length ? 'current' : ''}">4 提问并执行</span>
    </div>
    <div class="live-grid">
      <div class="card">
        <div class="card-h">自然语言问数 <span class="hint">真实模型生成 · 真实数据查询</span></div>
        <div class="live-chat" id="live-chat">
          ${app.messages.length ? app.messages.map(renderMessage).join('') : `<div class="live-empty"><strong>输入你想查询的数据问题</strong>
            <div>${!active ? '请先到“数据库与库表导入”连接 MySQL。' : !active.connected ? 'MySQL 连接已过期，请重新输入密码。' : !chosenTables.length ? '请先在“数据库与库表导入”中勾选并保存要参与问数的表。' : !app.model.configured ? '请到“模型配置”填写 OpenAI 兼容接口后开始提问。' : '当前已纳入 ' + chosenTables.length + ' 张表，可以用自然语言提问。'}</div>
            <div class="tinier" style="margin-top:7px">没有预置问题或答案；SQL 由你配置的模型实时生成。</div></div>`}
          ${app.busy ? '<div class="msg sys"><span class="av">NL</span><div class="body"><div class="who">系统</div><div class="bubble">正在请求模型并校验 SQL…</div></div></div>' : ''}
        </div>
        <div class="live-input">
          <div class="live-ask-status ${active?.connected && chosenTables.length ? 'ready' : 'pending'}" id="ask-database-status">${esc(databaseStatus)}</div>
          <textarea class="i" id="question-input" placeholder="例如：上个月各类别的销售金额是多少？请根据你的数据域提出问题。" maxlength="1000" ${app.busy ? 'disabled' : ''}></textarea>
          <div class="live-form-actions"><button class="btn btn-primary" data-ask ${app.busy ? 'disabled' : ''}>生成 SQL</button>
            <span class="tinier">Ctrl + Enter 提交。SQL 生成后需手动点击执行。</span></div>
        </div>
      </div>
      <div class="live-stack">
        <div class="card"><div class="card-h">当前数据域</div><div class="card-b">
          <div style="font-weight:600;margin-bottom:5px">${esc(active?.name || '尚未连接')}</div>
          <div class="live-note">${esc(active?.description || '未配置数据域描述。建议到元数据页补充业务背景、指标口径和表关系。')}</div>
          <div style="margin-top:12px">${chosenTables.slice(0, 14).map(t => `<span class="tag">${esc(t.name)}</span>`).join('') || '<span class="tinier">尚未选择表</span>'}</div>
        </div></div>
        <div class="card"><div class="card-h">生成依据</div><div class="card-b">
          ${last ? `<div class="live-note">${esc(last.rationale || '模型未提供说明')}</div>
            <div style="margin-top:12px" class="tinier">本次注入的表</div>
            <div style="margin-top:4px">${(last.selected_tables || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
            ${(last.used_terms || []).length ? `<div class="tinier" style="margin-top:8px">命中的业务术语：${last.used_terms.map(esc).join('、')}</div>` : ''}
            ${(last.assumptions || []).length ? `<div class="live-note" style="margin-top:8px">模型声明的假设（请核对）：${last.assumptions.map(esc).join('；')}</div>` : ''}
            <div class="tinier" style="margin-top:8px">模型自评：${last.confidence == null ? '未提供' : esc(last.confidence)}（不等同于正确率）</div>` : '<div class="live-note">生成 SQL 后，这里展示模型所依据的表与业务说明。</div>'}
        </div></div>
        <div class="card"><div class="card-h">执行边界</div><div class="card-b live-note">服务端仅接受单条 SELECT；MySQL 使用只读事务，SQLite 使用只读连接；敏感列禁止访问；查询限时 8 秒，最多展示 200 行。</div></div>
      </div>
    </div>`;
}

function renderMessage(message) {
  if (message.role === 'user') return `<div class="msg user"><span class="av">我</span><div class="body"><div class="who">你</div><div class="bubble">${esc(message.text)}</div></div></div>`;
  if (message.error) return `<div class="msg sys"><span class="av">NL</span><div class="body"><div class="who">系统错误</div><div class="alert danger">${esc(message.error)}</div></div></div>`;
  if (message.clarification) return `<div class="msg sys"><span class="av">NL</span><div class="body"><div class="who">需要澄清</div><div class="alert warn">${esc(message.clarification)}</div>
    ${(message.options || []).length ? `<div class="live-clarification-options">${message.options.map(option =>
      `<button class="btn btn-sm" data-clarification-option="${esc(option)}">${esc(option)}</button>`).join('')}</div>` : ''}
    <div class="tinier" style="margin-top:5px">选择一个选项，或在下方输入补充条件后继续。</div></div></div>`;
  const result = message.result;
  return `<div class="msg sys"><span class="av">NL</span><div class="body"><div class="who">已生成 SQL · ${message.elapsed_ms || 0}ms</div>
    <div class="bubble">${esc(message.rationale || '请审阅 SQL 是否符合业务口径。')}</div>
    <div class="live-result">
      <div class="head">可编辑 SQL · ${message.dialect === 'mysql' ? 'MySQL' : 'SQLite'} 方言</div>
      <textarea class="i" data-sql-edit="${message.id}" spellcheck="false">${esc(message.sql)}</textarea>
      <div class="foot"><button class="btn btn-primary btn-sm" data-execute="${message.id}" ${message.executing ? 'disabled' : ''}>${message.executing ? '执行中…' : '执行只读查询'}</button>
        <button class="btn btn-sm" data-copy="${message.id}">复制 SQL</button><span class="tinier">执行前会重新校验编辑后的 SQL</span></div>
      ${message.executionError ? `<div class="alert danger" style="margin:0 9px 9px">${esc(message.executionError)}</div>` : ''}
      ${result ? `<div class="sql-result">
        <div class="result-h"><span>结果 ${result.rows.length} 行${result.truncated ? '（已截断）' : ''}</span><span>执行 ${result.elapsed_ms}ms</span></div>
        <table class="tbl"><thead><tr>${result.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${result.rows.map(row => `<tr>${row.map(value => `<td>${esc(value === null ? 'NULL' : value)}</td>`).join('')}</tr>`).join('')}</tbody></table>
        ${!result.rows.length ? '<div class="empty">查询成功，结果为空</div>' : ''}
      </div>` : ''}
    </div></div></div>`;
}

function filteredSchema() {
  const query = app.tableFilter.trim().toLocaleLowerCase();
  if (!query) return app.schema;
  return app.schema.filter(table => [table.name, table.description,
    ...table.columns.map(column => column.name + ' ' + column.description)]
    .some(value => String(value || '').toLocaleLowerCase().includes(query)));
}

function renderScopeRows() {
  const rows = filteredSchema();
  return rows.map(table => {
    const checked = app.scopeDraft.has(table.name);
    const primary = table.columns.filter(column => column.primary_key).map(column => column.name).join(', ') || '—';
    return `<label class="live-scope-row ${checked ? 'selected' : ''}">
      <input type="checkbox" data-scope-table="${esc(table.name)}" ${checked ? 'checked' : ''}>
      <span class="live-scope-name">${esc(table.name)}<small>${esc(table.kind === 'view' ? '视图' : '数据表')}</small></span>
      <span class="live-scope-description">${esc(table.description || '暂无表注释')}</span>
      <span class="live-scope-count">${table.columns.length} 字段</span>
      <span class="live-scope-key" title="主键">${esc(primary)}</span>
      <span class="live-scope-state">${checked ? '已勾选' : '未勾选'}</span>
    </label>`;
  }).join('') || '<div class="empty">没有匹配的表，请调整筛选词</div>';
}

function updateScopeSummary() {
  const count = $('#scope-count');
  if (count) count.textContent = `当前勾选 ${app.scopeDraft.size} 张 · 已保存 ${(app.meta?.included_tables || []).length} 张`;
  const button = $('#save-scope');
  if (button) button.textContent = `保存问数范围（${app.scopeDraft.size} 张）`;
  const dirty = $('#scope-dirty');
  const saved = new Set(app.meta?.included_tables || []);
  if (dirty) dirty.textContent = app.scopeDraft.size === saved.size && [...app.scopeDraft].every(name => saved.has(name))
    ? '当前选择已保存' : '选择有改动，保存后生效';
}

function refreshScopeRows() {
  const list = $('#scope-table-list');
  if (!list) return;
  const position = list.scrollTop;
  list.innerHTML = renderScopeRows();
  list.scrollTop = position;
  const visible = $('#scope-visible');
  if (visible) visible.textContent = `显示 ${filteredSchema().length} / ${app.schema.length} 张`;
  updateScopeSummary();
}

function renderSources() {
  const source = app.draft;
  const included = includedTables();
  return `<div class="page-head"><div><h1>数据库与库表导入</h1><div class="sub">连接 MySQL，读取真实库表结构，再选择参与问数的表</div></div></div>
    <div class="card"><div class="card-h">① 连接 MySQL <span class="hint">请使用仅有 SELECT 权限的专用账号</span></div><div class="card-b">
      <div class="form-grid">
        <div><label class="f">连接名称</label><input class="i" id="mysql-name" value="${esc(source?.type === 'mysql' ? source.name : '')}" placeholder="例如：经营分析库"></div>
        <div><label class="f"><span class="req">*</span>主机地址</label><input class="i" id="mysql-host" value="${esc(source?.type === 'mysql' ? source.host : '')}" placeholder="127.0.0.1 或数据库内网地址"></div>
        <div><label class="f"><span class="req">*</span>端口</label><input class="i" id="mysql-port" type="number" value="${esc(source?.type === 'mysql' ? source.port : 3306)}"></div>
        <div><label class="f"><span class="req">*</span>数据库名</label><input class="i" id="mysql-db" value="${esc(source?.type === 'mysql' ? source.database : '')}" placeholder="database 名称"></div>
        <div><label class="f"><span class="req">*</span>只读账号</label><input class="i" id="mysql-user" value="${esc(source?.type === 'mysql' ? source.user : '')}" placeholder="建议使用只读专用账号"></div>
        <div><label class="f">密码</label><input class="i" id="mysql-password" type="password" autocomplete="off" placeholder="仅保存在当前服务进程内存中"></div>
      </div>
      <div class="live-form-actions"><button class="btn btn-primary" data-connect-mysql>${source?.type === 'mysql' ? '连接 / 更新当前 MySQL' : '连接 MySQL'}</button>
        <span class="tinier">地址、库名和账号保存在本地；密码不落盘，重启后需重新输入。</span></div>
      <div class="alert danger" id="mysql-error" style="display:none;margin-top:12px" role="alert"></div>
    </div></div>
    ${!source || !source.connected ? `<div class="card"><div class="live-empty"><strong>${source ? '请重新连接 MySQL' : '还没有连接数据库'}</strong>${source ? '密码未保存在磁盘，输入密码并点击“连接 / 更新当前 MySQL”。' : '填写连接信息，连接后将读取库表结构供你筛选。'}</div></div>` : `
      ${source.type === 'mysql' ? `<div class="card"><div class="card-h">② 读取并筛选库表结构 <span class="hint">${app.schema.length} 张表或视图 · 仅导入结构，不复制业务数据</span></div><div class="card-b">
        <div class="alert info">已从当前数据库读取表名、字段、主键和原生注释。勾选并保存后，只有这些表会进入问数范围。</div>
        <div class="live-scope-toolbar">
          <input class="i" id="scope-filter" value="${esc(app.tableFilter)}" placeholder="搜索表名、表注释或字段名">
          <button class="btn btn-sm" data-refresh-schema>重新读取结构</button>
          <button class="btn btn-sm" data-scope-bulk="select">勾选筛选结果</button>
          <button class="btn btn-sm" data-scope-bulk="clear">取消筛选结果</button>
        </div>
        <div class="live-scope-summary"><strong id="scope-count">当前勾选 ${app.scopeDraft.size} 张 · 已保存 ${(app.meta?.included_tables || []).length} 张</strong>
          <span id="scope-visible">显示 ${filteredSchema().length} / ${app.schema.length} 张</span></div>
        <div class="live-scope-header"><span></span><span>表名</span><span>原生注释</span><span>字段数</span><span>主键</span><span>状态</span></div>
        <div class="live-scope-list" id="scope-table-list">${renderScopeRows()}</div>
        <div class="live-form-actions"><button class="btn btn-primary" id="save-scope" data-save-scope>保存问数范围（${app.scopeDraft.size} 张）</button>
          <span class="tinier" id="scope-dirty">选择有改动，保存后生效</span></div>
      </div></div>` : ''}
      ${included.length ? `<div class="card"><div class="card-b live-next-step"><div><strong>库表范围已导入</strong><div class="live-note">已保存 ${included.length} 张表，可以继续配置表、字段和关系的业务含义。</div></div>
        <button class="btn btn-primary" data-view="metadata">进入元数据配置 →</button></div></div>` : ''}`}`;
}

function renderMetadataPage() {
  const source = app.draft;
  const included = includedTables();
  if (!source || !included.length) return '';
  return `<div class="page-head"><div><h1>元数据配置</h1><div class="sub">为已导入的库表补充业务名称、字段描述和表关系</div></div></div>
    ${renderMetadataWorkspace(source, included)}`;
}

function relationKey(item) {
  return `${item.from_table}.${item.from_col}=${item.to_table}.${item.to_col}`;
}

function querySetting(source, tableName) {
  const value = source.table_query_settings?.[tableName] || {};
  return {
    entity_key: value.entity_key || '', time_field: value.time_field || '',
    sort_field: value.sort_field || '', sort_direction: value.sort_direction || 'DESC',
    default_limit: Number(value.default_limit || 100),
    default_fields: Array.isArray(value.default_fields) ? value.default_fields : [],
    filterable_fields: Array.isArray(value.filterable_fields) ? value.filterable_fields : [],
  };
}

function ensureQuerySetting(source, tableName) {
  source.table_query_settings ||= {};
  source.table_query_settings[tableName] ||= querySetting(source, tableName);
  return source.table_query_settings[tableName];
}

function tableCompletion(table, source) {
  const name = table.name;
  const info = [
    ['表业务名', source.table_business_names?.[name]],
    ['表解释', source.table_docs?.[name]],
    ['用途说明', source.table_purposes?.[name]],
  ];
  const missingInfo = info.filter(([, value]) => !String(value || '').trim()).map(([label]) => label);
  const infoCount = info.length - missingInfo.length;
  const sensitive = new Set(source.sensitive_columns || []);
  const fields = table.columns.filter(column => !sensitive.has(`${name}.${column.name}`));
  const missingFields = fields.filter(column => !String(source.column_business_names?.[name]?.[column.name] || '').trim()
    || !String(source.column_docs?.[name]?.[column.name] || '').trim());
  const fieldCount = fields.length - missingFields.length;
  const setting = querySetting(source, name);
  const visibleNames = new Set(fields.map(column => column.name));
  const detailFields = setting.default_fields.filter(field => visibleNames.has(field));
  const physicalKey = fields.some(column => column.primary_key);
  const requiredMissing = [];
  if (!String(source.table_business_names?.[name] || '').trim()) requiredMissing.push('表业务名');
  if (!String(source.table_docs?.[name] || '').trim()) requiredMissing.push('表解释');
  if (!fieldCount) requiredMissing.push('至少 1 个核心字段的业务名和描述');
  const enhancedMissing = [];
  if (!String(source.table_purposes?.[name] || '').trim()) enhancedMissing.push('用途说明');
  if (!detailFields.length) enhancedMissing.push('明细默认展示字段');
  if (!physicalKey && !visibleNames.has(setting.entity_key)) enhancedMissing.push('实体唯一字段');
  const queryable = !requiredMissing.length;
  const basicTarget = Math.min(fields.length, 5);
  const basic = queryable && infoCount === 3 && fieldCount >= basicTarget && detailFields.length;
  const complete = basic && !missingFields.length && (physicalKey || visibleNames.has(setting.entity_key))
    && visibleNames.has(setting.sort_field);
  const state = complete ? 'complete' : basic ? 'basic' : queryable ? 'queryable' : 'risk';
  return { state, infoCount, fieldCount, fieldTotal: fields.length, missingInfo,
    missingFieldCount: missingFields.length, requiredMissing, enhancedMissing };
}

function completionDetail(completion) {
  if (completion.state === 'complete') return '完整配置：全部非敏感字段和明细查询设置已就绪。';
  if (completion.requiredMissing.length) return `必要项待补：${completion.requiredMissing.join('、')}。`;
  const extra = [...completion.enhancedMissing];
  if (completion.missingFieldCount) extra.push(`${completion.missingFieldCount} 个字段描述`);
  return `${completion.state === 'basic' ? '基本完成' : '已可问数'}；增强项待补：${extra.join('、') || '无'}。`;
}

function renderMetadataTableList(source, included) {
  const query = app.metaFilter.trim().toLocaleLowerCase();
  const rows = included.filter(table => {
    const completion = tableCompletion(table, source);
    if (app.metaStatus !== 'all' && completion.state !== app.metaStatus) return false;
    return !query || [table.name, table.native_comment, source.table_business_names?.[table.name]]
      .some(value => String(value || '').toLocaleLowerCase().includes(query));
  });
  return rows.map(table => {
    const completion = tableCompletion(table, source);
    const label = completion.state === 'complete' ? '完整配置' : completion.state === 'basic' ? '基本完成'
      : completion.state === 'queryable' ? '可问数' : '存在风险';
    return `<div class="tbl-item live-meta-table ${table.name === app.selectedTable ? 'sel' : ''}" data-table="${esc(table.name)}">
      <div class="nm ${completion.state}">${esc(source.table_business_names?.[table.name] || table.name)}</div>
      <div class="sn">${esc(table.name)} · ${label}<br>表信息 ${completion.infoCount}/3 · 字段 ${completion.fieldCount}/${completion.fieldTotal}</div>
    </div>`;
  }).join('') || '<div class="empty">没有匹配的已纳入表</div>';
}

function refreshMetadataProgress() {
  if (!app.draft) return;
  const included = includedTables();
  const list = $('#meta-table-list');
  if (list) {
    const position = list.scrollTop;
    list.innerHTML = renderMetadataTableList(app.draft, included);
    list.scrollTop = position;
  }
  const selected = included.find(table => table.name === app.selectedTable);
  if (!selected) return;
  const completion = tableCompletion(selected, app.draft);
  const progress = $('#meta-completion-progress');
  if (progress) progress.textContent = `表信息 ${completion.infoCount}/3 · 字段 ${completion.fieldCount}/${completion.fieldTotal}`;
  const detail = $('#meta-completion-detail');
  if (detail) detail.textContent = completionDetail(completion);
  const name = $('#meta-identity-name');
  if (name) name.textContent = app.draft.table_business_names?.[selected.name] || selected.native_comment || '未填写业务名';
}

function metadataRelationships(source, included) {
  const allowed = new Set(included.map(table => table.name));
  const manual = new Map((source.relations || []).filter(item => allowed.has(item.from_table)
    && allowed.has(item.to_table)).map(item => [relationKey(item), item]));
  const found = new Map();
  for (const table of included) {
    for (const fk of table.foreign_keys) {
      if (!allowed.has(fk.to_table)) continue;
      const item = { from_table: table.name, from_col: fk.from, to_table: fk.to_table,
        to_col: fk.to, manual: false };
      const key = relationKey(item);
      if (fk.origin === 'manual' && !manual.has(key)) continue;
      item.manual = manual.has(key);
      found.set(key, item);
    }
  }
  for (const [key, item] of manual) found.set(key, { ...item, manual: true });
  return [...found.values()];
}

function renderMetadataWizard(source, included) {
  const states = included.map(table => tableCompletion(table, source));
  const queryable = states.filter(item => item.state !== 'risk').length;
  const complete = states.filter(item => item.state === 'complete').length;
  const tableReady = included.filter(table => String(source.table_business_names?.[table.name] || '').trim()
    && String(source.table_docs?.[table.name] || '').trim()).length;
  const coreFieldReady = states.filter(item => item.fieldCount > 0).length;
  const relations = metadataRelationships(source, included).length;
  const detailReady = included.filter(table => querySetting(source, table.name).default_fields.length).length;
  const steps = [
    ['sources', '1', '选择核心表', `${included.length} 张已纳入`, true],
    ['table', '2', '表业务信息', `${tableReady}/${included.length} 已配置`, tableReady === included.length],
    ['columns', '3', '核心字段', `${coreFieldReady}/${included.length} 已配置`, coreFieldReady === included.length],
    ['relations', '4', '表关系', included.length > 1 ? `${relations} 条` : '单表可跳过', included.length === 1 || relations > 0],
    ['query', '5', '明细查询', `${detailReady}/${included.length} 已配置`, detailReady === included.length],
    ['ask', '6', '测试问数', '验证实际效果', false],
  ];
  return `<div class="live-wizard"><div class="live-wizard-head"><div><strong>元数据配置向导</strong>
      <span>先补必要项即可问数，再逐步完善增强配置。</span></div>
      <span class="tag">${queryable}/${included.length} 可问数 · ${complete}/${included.length} 完整</span></div>
    <div class="live-wizard-steps">${steps.map(([target, number, title, note, done]) =>
      `<button type="button" data-wizard-step="${target}" class="${done ? 'done' : ''}"><b>${done ? '✓' : number}</b><span>${title}<small>${note}</small></span></button>`).join('')}</div></div>`;
}

function renderMetadataWorkspace(source, included) {
  const selected = included.find(table => table.name === app.selectedTable) || included[0];
  if (!selected) return '';
  const completion = tableCompletion(selected, source);
  const relationships = metadataRelationships(source, included).filter(item =>
    item.from_table === selected.name || item.to_table === selected.name);
  const fromTable = included.find(table => table.name === app.relationFromTable) || selected;
  const toTable = included.find(table => table.name === app.relationToTable)
    || included.find(table => table.name !== selected.name) || selected;
  return `<div class="card" id="metadata-workspace"><div class="card-h">业务元数据配置
      <span class="hint">已纳入 ${included.length} 张表 · 表信息、字段描述和关系会进入后续问数依据</span></div>
    <div class="card-b"><div class="form-grid">
      <div><label class="f">数据域描述</label><textarea class="i" data-meta="description" placeholder="这组数据记录什么业务，适合回答哪些问题">${esc(source.description || '')}</textarea></div>
      <div><label class="f">业务术语与指标口径</label><textarea class="i" data-meta="glossary" placeholder="关键指标定义、时间口径、状态枚举等">${esc(source.glossary || '')}</textarea></div>
    </div></div></div>
    ${renderMetadataWizard(source, included)}
    <div class="live-meta-grid">
      <div class="panel"><div class="panel-h">已纳入的表 <span class="hint">${included.length} 张</span></div>
        <div class="panel-b">
          <div class="live-completion-guide"><strong>完成度规则</strong>
            <div><b>必要项：</b>表业务名、表解释，以及至少 1 个核心字段的业务名和描述。满足后标记为“可问数”。</div>
            <div><b>增强项：</b>用途、更多字段、明细默认字段、唯一标识和排序。逐步达到“基本完成”和“完整配置”。</div></div>
          <input class="i" id="meta-filter" value="${esc(app.metaFilter)}" placeholder="搜索表名 / 业务名">
          <select class="i live-meta-status" id="meta-status">
            <option value="all" ${app.metaStatus === 'all' ? 'selected' : ''}>全部完成度</option>
            <option value="risk" ${app.metaStatus === 'risk' ? 'selected' : ''}>存在风险</option>
            <option value="queryable" ${app.metaStatus === 'queryable' ? 'selected' : ''}>可问数</option>
            <option value="basic" ${app.metaStatus === 'basic' ? 'selected' : ''}>基本完成</option>
            <option value="complete" ${app.metaStatus === 'complete' ? 'selected' : ''}>完整配置</option>
          </select>
          <div class="live-table-list" id="meta-table-list">${renderMetadataTableList(source, included)}</div>
        </div></div>
      <div class="panel"><div class="live-meta-tabs">
          <button data-meta-tab="table" class="${app.metaTab === 'table' ? 'active' : ''}">表信息</button>
          <button data-meta-tab="columns" class="${app.metaTab === 'columns' ? 'active' : ''}">字段描述</button>
          <button data-meta-tab="relations" class="${app.metaTab === 'relations' ? 'active' : ''}">表关系</button>
          <button data-meta-tab="query" class="${app.metaTab === 'query' ? 'active' : ''}">明细查询</button>
          <button class="btn btn-primary btn-sm live-meta-save" data-save-metadata>保存元数据</button>
        </div>
        <div class="panel-b">
          <div class="live-meta-identity"><span class="tag">${esc(selected.name)}</span>
            <span id="meta-identity-name">${esc(source.table_business_names?.[selected.name] || selected.native_comment || '未填写业务名')}</span>
            <span class="live-meta-progress" id="meta-completion-progress">表信息 ${completion.infoCount}/3 · 字段 ${completion.fieldCount}/${completion.fieldTotal}</span></div>
          <div class="live-completion-detail" id="meta-completion-detail">${esc(completionDetail(completion))}</div>
          ${app.metaTab === 'table' ? renderTableInfoTab(source, selected)
            : app.metaTab === 'columns' ? renderFieldTab(source, selected)
            : app.metaTab === 'relations' ? renderRelationshipTab(source, included, selected, relationships, fromTable, toTable)
            : renderQuerySettingsTab(source, selected)}
        </div></div>
    </div>
    <div class="live-form-actions"><button class="btn btn-primary" data-save-metadata>保存元数据与业务口径</button>
      <span class="tinier">AI 草稿只填入编辑框，需你审阅并点击保存。</span></div>`;
}

function renderTableInfoTab(source, selected) {
  const name = selected.name;
  return `<div class="live-meta-form">
    <div class="live-note">物理表名：<span class="mono">${esc(name)}</span> · 原生注释：${esc(selected.native_comment || '无')}</div>
    <label class="f">表业务名</label><input class="i" data-table-business="${esc(name)}"
      value="${esc(source.table_business_names?.[name] || '')}" placeholder="例如：订单主表">
    <label class="f">表解释（一行代表什么）</label><textarea class="i" data-table-doc="${esc(name)}"
      placeholder="解释记录粒度、关键状态和主要字段含义">${esc(source.table_docs?.[name] || '')}</textarea>
    <label class="f">用途说明（适合回答什么问题）</label><textarea class="i" data-table-purpose="${esc(name)}"
      placeholder="例如：用于按日期和地区统计已支付订单">${esc(source.table_purposes?.[name] || '')}</textarea>
    <div class="live-form-actions"><button class="btn btn-sm" data-draft-table ${app.model.configured ? '' : 'disabled'}>AI 生成描述草稿</button>
      <button class="btn btn-sm" data-fill-comments>从原生 COMMENT 回填</button>
      <span class="tinier">${app.model.configured ? '草稿来自已配置模型，不会自动保存。' : '配置模型后可生成真实草稿。'}</span></div>
  </div>`;
}

function renderFieldTab(source, selected) {
  const name = selected.name;
  return `<div class="alert info">字段业务名、描述和取值说明会帮助模型理解口径。标记敏感的字段不会进入模型上下文，也不能用于查询。</div>
    <div class="live-form-actions"><button class="btn btn-sm" data-draft-columns ${app.model.configured ? '' : 'disabled'}>AI 草拟最多 20 个空白字段</button>
      <button class="btn btn-sm" data-fill-comments>从原生 COMMENT 回填空白说明</button>
      <span class="tinier">字段共 ${selected.columns.length} 个；可分批草拟并人工核对。</span></div>
    <div class="live-field-scroll"><div class="live-field-header"><span>物理字段 / 类型</span><span>字段业务名</span><span>字段描述</span><span>取值说明</span><span>敏感</span></div>
      ${selected.columns.map(column => `<div class="live-field-row">
        <div class="live-field-physical"><strong>${esc(column.name)}</strong>${column.primary_key ? '<span class="live-pk">PK</span>' : ''}
          <small>${esc(column.type)}${column.native_comment ? ' · ' + esc(column.native_comment) : ''}</small></div>
        <input class="i" data-column-business="${esc(column.name)}" data-table-name="${esc(name)}"
          value="${esc(source.column_business_names?.[name]?.[column.name] || '')}" placeholder="业务名称">
        <input class="i" data-column-doc="${esc(column.name)}" data-table-name="${esc(name)}"
          value="${esc(source.column_docs?.[name]?.[column.name] || '')}" placeholder="业务含义、单位">
        <input class="i" data-column-values="${esc(column.name)}" data-table-name="${esc(name)}"
          value="${esc(source.column_value_hints?.[name]?.[column.name] || '')}" placeholder="枚举值或口径">
        <label class="live-sensitive"><input type="checkbox" data-sensitive="${esc(column.name)}" data-table-name="${esc(name)}"
          ${source.sensitive_columns?.includes(`${name}.${column.name}`) ? 'checked' : ''}><span>敏感</span></label>
      </div>`).join('')}</div>`;
}

function renderRelationshipTab(source, included, selected, relationships, fromTable, toTable) {
  const docs = source.relation_docs || {};
  const cardOptions = ['未知', 'N:1', '1:N', '1:1', 'N:M'];
  return `<div class="alert info">表关系决定多表 JOIN 路径。跨表查询所需的中间表也必须纳入问数范围；基数和说明由你确认。</div>
    <div class="live-relation-scroll"><div class="live-relation-header"><span>本表 / 来源字段</span><span></span><span>对方表字段</span><span>基数</span><span>关系说明</span><span></span></div>
      ${relationships.map(item => {
        const key = relationKey(item);
        const detail = docs[key] || {};
        return `<div class="live-relation-row"><span class="mono">${esc(item.from_table)}.${esc(item.from_col)}<small>${item.manual ? '手工关系' : '数据库外键'}</small></span>
          <span>=</span><span class="mono">${esc(item.to_table)}.${esc(item.to_col)}</span>
          <select class="i" data-relation-cardinality="${esc(key)}">${cardOptions.map(value => `<option value="${value}" ${detail.cardinality === value || !detail.cardinality && value === '未知' ? 'selected' : ''}>${value}</option>`).join('')}</select>
          <input class="i" data-relation-description="${esc(key)}" value="${esc(detail.description || '')}" placeholder="关联用途与去重规则">
          ${item.manual ? `<button class="btn btn-sm" data-remove-relation="${esc(key)}">删除</button>` : '<span></span>'}</div>`;
      }).join('') || '<div class="empty">当前表没有已识别关系；可在下方添加手工关系。</div>'}</div>
    <div class="live-relation-add"><strong>新增手工关系</strong><div class="live-relation-add-grid">
      <select class="i" id="rel-from-table">${included.map(table => `<option value="${esc(table.name)}" ${table.name === fromTable.name ? 'selected' : ''}>${esc(table.name)}</option>`).join('')}</select>
      <select class="i" id="rel-from-col">${fromTable.columns.map(column => `<option value="${esc(column.name)}">${esc(column.name)}</option>`).join('')}</select>
      <span class="live-relation-eq">=</span>
      <select class="i" id="rel-to-table">${included.map(table => `<option value="${esc(table.name)}" ${table.name === toTable.name ? 'selected' : ''}>${esc(table.name)}</option>`).join('')}</select>
      <select class="i" id="rel-to-col">${toTable.columns.map(column => `<option value="${esc(column.name)}">${esc(column.name)}</option>`).join('')}</select>
      <button class="btn btn-sm" data-add-relation>添加关系</button>
    </div></div>`;
}

function renderQuerySettingsTab(source, selected) {
  const name = selected.name;
  const setting = querySetting(source, name);
  const sensitive = new Set(source.sensitive_columns || []);
  const columns = selected.columns.filter(column => !sensitive.has(`${name}.${column.name}`));
  const options = (selectedValue, emptyLabel) => `<option value="">${emptyLabel}</option>`
    + columns.map(column => `<option value="${esc(column.name)}" ${column.name === selectedValue ? 'selected' : ''}>${esc(column.name)}${column.primary_key ? '（PK）' : ''}</option>`).join('');
  const checks = (field, selectedValues) => `<div class="live-query-checks">${columns.map(column =>
    `<label><input type="checkbox" data-query-list="${field}" data-table-name="${esc(name)}" value="${esc(column.name)}"
      ${selectedValues.includes(column.name) ? 'checked' : ''}><span>${esc(source.column_business_names?.[name]?.[column.name]
        || source.column_docs?.[name]?.[column.name] || column.business_name || column.description || column.name)}</span><small>${esc(column.name)}</small></label>`).join('')}</div>`;
  return `<div class="alert info">用于“查看明细、清单、台账”这类未明确指定列的问题。用户明确指定的字段、时间、排序和条数始终优先。</div>
    <div class="live-query-form">
      <div><label class="f">实体唯一字段</label><select class="i" data-query-setting="entity_key" data-table-name="${esc(name)}">${options(setting.entity_key, '未配置')}</select>
        <div class="tinier">用于一对多关联时去重；有主键时可直接选择主键。</div></div>
      <div><label class="f">默认时间字段</label><select class="i" data-query-setting="time_field" data-table-name="${esc(name)}">${options(setting.time_field, '未配置')}</select></div>
      <div><label class="f">默认排序字段</label><select class="i" data-query-setting="sort_field" data-table-name="${esc(name)}">${options(setting.sort_field, '未配置')}</select></div>
      <div><label class="f">排序方向</label><select class="i" data-query-setting="sort_direction" data-table-name="${esc(name)}">
        <option value="DESC" ${setting.sort_direction === 'DESC' ? 'selected' : ''}>倒序（新到旧 / 大到小）</option>
        <option value="ASC" ${setting.sort_direction === 'ASC' ? 'selected' : ''}>正序（旧到新 / 小到大）</option></select></div>
      <div><label class="f">默认返回条数</label><input class="i" type="number" min="1" max="200" data-query-setting="default_limit" data-table-name="${esc(name)}" value="${esc(setting.default_limit)}"></div>
    </div>
    <div class="live-query-section"><div class="live-query-title"><div><strong>默认展示字段</strong><span>建议选择 5～10 个业务常用字段</span></div>
      <button class="btn btn-sm" type="button" data-suggest-query>自动推荐</button></div>${checks('default_fields', setting.default_fields)}</div>
    <div class="live-query-section"><div class="live-query-title"><div><strong>常用筛选字段</strong><span>例如日期、地区、状态、企业等</span></div></div>
      ${checks('filterable_fields', setting.filterable_fields)}</div>`;
}

function renderModel() {
  return `<div class="page-head"><div><h1>模型配置</h1><div class="sub">连接支持 OpenAI 兼容 chat/completions 接口的云端或本地模型</div></div></div>
    <div class="live-grid"><div class="card"><div class="card-h">模型连接</div><div class="card-b">
      <div class="alert info" style="margin-bottom:14px">API Key 只保存在当前本地服务进程的内存中，重启后需重新填写；不会写入配置文件。</div>
      <div class="form-grid">
        <div class="full"><label class="f"><span class="req">*</span>Base URL</label><input class="i" id="model-base" value="${esc(app.model.base_url || '')}" placeholder="https://你的模型服务/v1 或 http://127.0.0.1:11434/v1"></div>
        <div><label class="f"><span class="req">*</span>模型名称</label><input class="i" id="model-name" value="${esc(app.model.model || '')}" placeholder="填写服务商提供的模型 ID"></div>
        <div><label class="f">请求超时（秒）</label><input class="i" id="model-timeout" type="number" min="5" max="120" value="${esc(app.model.timeout || 120)}"></div>
        <div><label class="f">输出 Token 上限</label><input class="i" id="model-max-tokens" type="number" min="256" max="32768" step="256" value="${esc(app.model.max_tokens || 8192)}">
          <div class="tinier" style="margin-top:5px">思考模型的推理和最终回答共用此额度；hy4-preview 建议先用 8192，不足时调至 16384。</div></div>
        <div class="full"><label class="f">API Key ${app.model.key_set ? '（已设置；留空表示保留）' : '（本地无鉴权模型可留空）'}</label><input class="i" id="model-key" type="password" autocomplete="off" placeholder="粘贴 Key，不会保存到磁盘"></div>
      </div>
      <div class="live-form-actions"><button class="btn btn-primary" data-save-model>保存连接</button><button class="btn" data-test-model ${app.model.configured ? '' : 'disabled'}>测试真实模型调用</button>
        <span class="badge ${app.model.configured ? 'ok' : 'warn'}">${app.model.configured ? '已配置' : '未配置'}</span></div>
    </div></div>
    <div class="live-stack"><div class="card"><div class="card-h">调用流程</div><div class="card-b">
      <ol class="live-help"><li>后端读取当前数据源的真实表结构。</li><li>将已保存的业务口径与相关表交给模型。</li><li>模型返回 SQL 后，后端先进行只读与结构校验。</li><li>你确认 SQL 后点击执行，结果直接来自本地数据库。</li></ol>
    </div></div>
    <div class="card"><div class="card-h">兼容性说明</div><div class="card-b live-note">本地模型可填写其 OpenAI 兼容地址。部分服务商的接口格式、模型参数或鉴权方式可能不同；保存后请点击“测试真实模型调用”核实。</div></div></div></div>`;
}

async function askQuestion() {
  const input = $('#question-input');
  const text = input?.value.trim() || '';
  if (app.busy || app.submitting) return;
  const sourceId = app.sourceId;
  app.submitting = true;
  try {
    let status;
    try { status = await request('/api/status'); }
    catch (error) { toast(error.message); return; }
    if (app.sourceId !== sourceId) return;
    app.sources = status.sources;
    app.model = status.model;
    const active = app.sources.find(s => s.id === sourceId);
    const tableCount = active?.type === 'mysql' ? (active.included_tables || []).length : app.schema.length;
    const statusLabel = $('#ask-database-status');
    if (statusLabel) {
      statusLabel.textContent = !active ? '数据库未配置：请先到“数据库与库表导入”连接 MySQL。'
        : !active.connected ? '数据库未连接：请到“数据库与库表导入”重新输入密码。'
        : !tableCount ? '数据库已连接，尚未导入库表：请筛选并保存问数范围。'
        : `数据库已配置：已导入 ${tableCount} 张表。`;
      statusLabel.className = `live-ask-status ${active?.connected && tableCount ? 'ready' : 'pending'}`;
    }
    if (!active) { toast('数据库未配置，请先到“数据库与库表导入”连接 MySQL'); return; }
    if (!active.connected) {
      toast('数据库未连接，请到“数据库与库表导入”重新输入密码'); return;
    }
    if (!tableCount) { toast('数据库尚未导入库表，请先筛选并保存问数范围'); return; }
    if (!app.model.configured) { toast('请先配置模型'); return; }
    if (!text) { toast('请输入要查询的问题'); input?.focus(); return; }
    const original = app.pendingQuestion ? `${app.pendingQuestion}\n补充条件：${text}` : text;
    app.messages.push({ role: 'user', text });
    app.busy = true;
    render();
    try {
      const answer = await request('/api/generate', 'POST', { source_id: sourceId, question: original });
      if (app.sourceId !== sourceId) {
        toast('数据源已切换，本次生成结果已丢弃');
        return;
      }
      if (answer.need_clarification) {
        app.pendingQuestion = original;
        app.messages.push({ role: 'assistant', clarification: answer.clarification_question,
          options: answer.clarification_options || [] });
      } else {
        app.pendingQuestion = '';
        app.messages.push({ role: 'assistant', id: `m${Date.now()}_${Math.random()}`, sql: answer.sql,
          rationale: answer.rationale, selected_tables: answer.selected_tables, used_tables: answer.used_tables,
          used_terms: answer.used_terms, assumptions: answer.assumptions,
          confidence: answer.confidence, elapsed_ms: answer.elapsed_ms,
          sourceId, dialect: active.type });
      }
    } catch (error) {
      if (app.sourceId === sourceId) app.messages.push({ role: 'assistant', error: error.message });
    } finally {
      app.busy = false;
      render();
    }
  } finally {
    app.submitting = false;
  }
}

async function executeMessage(id) {
  const message = app.messages.find(m => m.id === id);
  if (!message || message.executing) return;
  message.executing = true;
  message.executionError = '';
  message.result = null;
  render();
  try {
    message.result = await request('/api/execute', 'POST', { source_id: message.sourceId, sql: message.sql });
  } catch (error) {
    message.executionError = error.message;
  } finally {
    message.executing = false;
    render();
  }
}

async function connectMySQL() {
  const current = app.sources.find(s => s.id === app.sourceId);
  const body = {
    name: $('#mysql-name').value.trim(), host: $('#mysql-host').value.trim(),
    port: Number($('#mysql-port').value || 3306), database: $('#mysql-db').value.trim(),
    user: $('#mysql-user').value.trim(), password: $('#mysql-password').value,
  };
  if (current?.type === 'mysql') body.source_id = current.id;
  const button = $('[data-connect-mysql]');
  const errorBox = $('#mysql-error');
  errorBox.style.display = 'none';
  errorBox.textContent = '';
  button.disabled = true; button.textContent = '连接中…';
  try {
    const result = await request('/api/connect-mysql', 'POST', body);
    toast(result.detail);
    app.messages = [];
    app.pendingQuestion = '';
    await refreshStatus(result.source.id);
  } catch (error) {
    toast(error.message);
    errorBox.textContent = error.message;
    errorBox.style.display = 'block';
    button.disabled = false; button.textContent = '连接 MySQL';
  }
}

async function refreshSchema() {
  const sourceId = app.sourceId;
  const button = $('[data-refresh-schema]');
  if (button) { button.disabled = true; button.textContent = '读取中…'; }
  try {
    const data = await request(`/api/schema?source_id=${encodeURIComponent(sourceId)}`);
    if (app.sourceId !== sourceId) return;
    app.schema = data.tables;
    app.meta = data.source;
    const valid = new Set(app.schema.map(table => table.name));
    app.scopeDraft = new Set([...app.scopeDraft].filter(name => valid.has(name)));
    prefillTableBusinessNames(app.draft, includedTables());
    if (!includedTables().some(table => table.name === app.selectedTable)) app.selectedTable = includedTables()[0]?.name || '';
    render();
    toast(`已读取 ${app.schema.length} 张表或视图`);
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = '重新读取结构'; }
  }
}

async function saveTableScope() {
  const sourceId = app.sourceId;
  const button = $('#save-scope');
  if (button) { button.disabled = true; button.textContent = '保存中…'; }
  try {
    const included = app.schema.filter(table => app.scopeDraft.has(table.name)).map(table => table.name);
    const source = await request('/api/table-scope', 'POST', {
      source_id: sourceId, included_tables: included,
    });
    if (app.sourceId !== sourceId) { toast('数据源已切换，旧页面的保存结果未加载'); return; }
    app.meta = source;
    app.draft.included_tables = source.included_tables;
    app.sources = app.sources.map(item => item.id === source.id ? source : item);
    app.scopeDraft = new Set(source.included_tables);
    prefillTableBusinessNames(app.draft, includedTables());
    if (!includedTables().some(table => table.name === app.selectedTable)) app.selectedTable = includedTables()[0]?.name || '';
    app.messages = [];
    app.pendingQuestion = '';
    render();
    toast(included.length ? `已保存 ${included.length} 张表，现在可以打开“元数据配置”` : '已清空问数范围');
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; updateScopeSummary(); }
  }
}

function fillNativeComments() {
  const table = includedTables().find(item => item.name === app.selectedTable);
  if (!table || !app.draft) return;
  const name = table.name;
  app.draft.table_business_names ||= {};
  app.draft.table_docs ||= {};
  app.draft.column_business_names ||= {};
  app.draft.column_docs ||= {};
  app.draft.column_business_names[name] ||= {};
  app.draft.column_docs[name] ||= {};
  let filled = 0;
  if (table.native_comment) {
    if (!app.draft.table_docs[name]) { app.draft.table_docs[name] = table.native_comment; filled++; }
    if (!app.draft.table_business_names[name] && table.native_comment.length <= 40) {
      app.draft.table_business_names[name] = table.native_comment; filled++;
    }
  }
  for (const column of table.columns) {
    if (!column.native_comment) continue;
    if (!app.draft.column_docs[name][column.name]) {
      app.draft.column_docs[name][column.name] = column.native_comment;
      filled++;
    }
    if (!app.draft.column_business_names[name][column.name] && column.native_comment.length <= 40) {
      app.draft.column_business_names[name][column.name] = column.native_comment;
      filled++;
    }
  }
  render();
  toast(filled ? `已从数据库原生注释回填 ${filled} 处空白，请核对后保存` : '没有可回填的空白项或原生注释');
}

async function draftTableMetadata() {
  const table = app.selectedTable;
  if (!table) return;
  const sourceId = app.sourceId;
  const button = $('[data-draft-table]');
  if (button) { button.disabled = true; button.textContent = '模型生成中…'; }
  try {
    const draft = await request('/api/metadata/draft', 'POST', { source_id: sourceId, table, mode: 'table' });
    if (app.sourceId !== sourceId || app.selectedTable !== table) {
      toast('数据源或表已切换，本次草稿已丢弃'); return;
    }
    app.draft.table_business_names ||= {};
    app.draft.table_docs ||= {};
    app.draft.table_purposes ||= {};
    if (!app.draft.table_business_names[table]) app.draft.table_business_names[table] = draft.business_name;
    if (!app.draft.table_docs[table]) app.draft.table_docs[table] = draft.explanation;
    if (!app.draft.table_purposes[table]) app.draft.table_purposes[table] = draft.purpose;
    render();
    toast('真实模型草稿已填入空白项，请审阅并保存');
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = 'AI 生成描述草稿'; }
  }
}

async function draftColumnMetadata() {
  const table = includedTables().find(item => item.name === app.selectedTable);
  if (!table) return;
  const source = app.draft;
  const name = table.name;
  const sourceId = app.sourceId;
  const names = table.columns.filter(column => !source.sensitive_columns?.includes(`${name}.${column.name}`)
    && (!source.column_business_names?.[name]?.[column.name] || !source.column_docs?.[name]?.[column.name]))
    .slice(0, 20).map(column => column.name);
  if (!names.length) { toast('当前表没有待草拟的非敏感字段'); return; }
  const button = $('[data-draft-columns]');
  if (button) { button.disabled = true; button.textContent = '模型生成中…'; }
  try {
    const draft = await request('/api/metadata/draft', 'POST', {
      source_id: sourceId, table: name, mode: 'columns', column_names: names,
    });
    if (app.sourceId !== sourceId || app.selectedTable !== name || app.draft !== source) {
      toast('数据源或表已切换，本次草稿已丢弃'); return;
    }
    for (const field of ['column_business_names', 'column_docs', 'column_value_hints']) {
      source[field] ||= {};
      source[field][name] ||= {};
    }
    for (const [column, detail] of Object.entries(draft.columns || {})) {
      if (!source.column_business_names[name][column]) source.column_business_names[name][column] = detail.business_name;
      if (!source.column_docs[name][column]) source.column_docs[name][column] = detail.description;
      if (!source.column_value_hints[name][column]) source.column_value_hints[name][column] = detail.value_hint;
    }
    render();
    toast(`模型返回 ${Object.keys(draft.columns || {}).length} 个字段草稿，请核对后保存`);
  } catch (error) {
    toast(error.message);
    if (button) { button.disabled = false; button.textContent = 'AI 草拟最多 20 个空白字段'; }
  }
}

function addManualRelation() {
  const relation = { from_table: $('#rel-from-table')?.value, from_col: $('#rel-from-col')?.value,
    to_table: $('#rel-to-table')?.value, to_col: $('#rel-to-col')?.value };
  if (!relation.from_table || !relation.from_col || !relation.to_table || !relation.to_col) {
    toast('请完整选择关系两侧的表和字段'); return;
  }
  if (relation.from_table === relation.to_table && relation.from_col === relation.to_col) {
    toast('关系两侧不能是同一个字段'); return;
  }
  const key = relationKey(relation);
  if (metadataRelationships(app.draft, includedTables()).some(item => relationKey(item) === key)) {
    toast('这条关系已经存在'); return;
  }
  app.draft.relations ||= [];
  app.draft.relations.push(relation);
  app.draft.relation_docs ||= {};
  app.draft.relation_docs[key] = { cardinality: '未知', description: '' };
  render();
  toast('关系已加入草稿，请填写基数和说明并保存');
}

function suggestQuerySettings() {
  const table = includedTables().find(item => item.name === app.selectedTable);
  if (!table || !app.draft) return;
  const name = table.name;
  const sensitive = new Set(app.draft.sensitive_columns || []);
  const columns = table.columns.filter(column => !sensitive.has(`${name}.${column.name}`));
  if (!columns.length) { toast('当前表没有可用于明细查询的非敏感字段'); return; }
  const setting = ensureQuerySetting(app.draft, name);
  const described = columns.filter(column => app.draft.column_business_names?.[name]?.[column.name]
    || app.draft.column_docs?.[name]?.[column.name]);
  const primary = columns.find(column => column.primary_key);
  const timeColumn = columns.find(column => /date|time|timestamp/i.test(column.type)
    || /(?:date|time|日期|时间|创建|更新)/i.test(`${column.name} ${column.description || ''}`));
  const preferred = [...(primary ? [primary] : []), ...described, ...columns];
  setting.default_fields = [...new Set(preferred.map(column => column.name))].slice(0, 8);
  setting.entity_key ||= primary?.name || '';
  setting.time_field ||= timeColumn?.name || '';
  setting.sort_field ||= timeColumn?.name || primary?.name || '';
  setting.sort_direction ||= 'DESC';
  setting.default_limit ||= 100;
  setting.filterable_fields = [...new Set([
    ...(timeColumn ? [timeColumn.name] : []),
    ...described.filter(column => /状态|地区|区域|类型|分类|名称|编码|status|region|type|category|name|code/i
      .test(`${column.name} ${column.description || ''}`)).map(column => column.name),
  ])].slice(0, 10);
  render();
  toast('已按主键、时间字段和已有描述生成建议，请核对后保存');
}

async function saveMetadata() {
  if (!app.draft) return;
  const sourceId = app.sourceId;
  const draft = app.draft;
  try {
    const result = await request('/api/metadata', 'POST', {
      source_id: sourceId, description: draft.description, glossary: draft.glossary,
      table_docs: draft.table_docs || {}, column_docs: draft.column_docs || {},
      table_business_names: draft.table_business_names || {}, table_purposes: draft.table_purposes || {},
      column_business_names: draft.column_business_names || {}, column_value_hints: draft.column_value_hints || {},
      relation_docs: draft.relation_docs || {},
      table_query_settings: draft.table_query_settings || {},
      sensitive_columns: draft.sensitive_columns || [],
      relations: (draft.relations || []).filter(item =>
        includedTables().some(table => table.name === item.from_table)
        && includedTables().some(table => table.name === item.to_table)),
    });
    if (app.sourceId !== sourceId || app.draft !== draft) {
      toast('数据源已切换，旧页面的保存结果未加载'); return;
    }
    app.meta = result;
    app.draft = JSON.parse(JSON.stringify(result));
    app.sources = app.sources.map(s => s.id === result.id ? result : s);
    await loadSchema();
    toast('元数据已保存，下次问数生效');
  } catch (error) { toast(error.message); }
}

async function saveModel() {
  const body = { base_url: $('#model-base').value.trim(), model: $('#model-name').value.trim(),
    timeout: Number($('#model-timeout').value || 120),
    max_tokens: Number($('#model-max-tokens').value || 8192) };
  const key = $('#model-key').value;
  if (key) body.api_key = key;
  try {
    app.model = await request('/api/model', 'POST', body);
    render();
    toast('模型配置已保存到当前服务进程');
  } catch (error) { toast(error.message); }
}

async function testModel() {
  const button = $('[data-test-model]');
  if (button) { button.disabled = true; button.textContent = '调用中…'; }
  try {
    const result = await request('/api/model/test', 'POST', {});
    toast('模型真实调用成功：' + result.reply);
  } catch (error) { toast(error.message); }
  finally { if (button) { button.disabled = false; button.textContent = '测试真实模型调用'; } }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-view],[data-table],[data-meta-tab],[data-wizard-step],[data-clarification-option],[data-ask],[data-execute],[data-copy],[data-connect-mysql],[data-refresh-schema],[data-scope-bulk],[data-save-scope],[data-save-metadata],[data-draft-table],[data-draft-columns],[data-fill-comments],[data-add-relation],[data-remove-relation],[data-suggest-query],[data-save-model],[data-test-model],[data-clear-chat]');
  if (!target) return;
  if (target.dataset.view) {
    if (target.dataset.view === 'metadata' && !canOpenMetadata()) {
      toast('请先连接数据库，并在“数据库与库表导入”中筛选和保存库表'); return;
    }
    app.view = target.dataset.view; render(); return;
  }
  if (target.dataset.table) {
    app.selectedTable = target.dataset.table;
    app.relationFromTable = target.dataset.table;
    app.relationToTable = '';
    render(); return;
  }
  if (target.dataset.wizardStep) {
    if (target.dataset.wizardStep === 'sources' || target.dataset.wizardStep === 'ask') {
      app.view = target.dataset.wizardStep; render(); return;
    }
    app.metaTab = target.dataset.wizardStep; render(); return;
  }
  if (target.dataset.clarificationOption) {
    const input = $('#question-input');
    if (input) { input.value = target.dataset.clarificationOption; input.focus(); }
    return;
  }
  if (target.dataset.metaTab) { app.metaTab = target.dataset.metaTab; render(); return; }
  if (target.hasAttribute('data-ask')) { askQuestion(); return; }
  if (target.dataset.execute) { executeMessage(target.dataset.execute); return; }
  if (target.dataset.copy) {
    const message = app.messages.find(m => m.id === target.dataset.copy);
    if (message) navigator.clipboard.writeText(message.sql).then(() => toast('SQL 已复制')).catch(() => toast('复制失败'));
    return;
  }
  if (target.hasAttribute('data-connect-mysql')) { connectMySQL(); return; }
  if (target.hasAttribute('data-refresh-schema')) { refreshSchema(); return; }
  if (target.dataset.scopeBulk) {
    for (const table of filteredSchema()) {
      if (target.dataset.scopeBulk === 'select') app.scopeDraft.add(table.name);
      else app.scopeDraft.delete(table.name);
    }
    refreshScopeRows();
    return;
  }
  if (target.hasAttribute('data-save-scope')) { saveTableScope(); return; }
  if (target.hasAttribute('data-save-metadata')) { saveMetadata(); return; }
  if (target.hasAttribute('data-draft-table')) { draftTableMetadata(); return; }
  if (target.hasAttribute('data-draft-columns')) { draftColumnMetadata(); return; }
  if (target.hasAttribute('data-fill-comments')) { fillNativeComments(); return; }
  if (target.hasAttribute('data-add-relation')) { addManualRelation(); return; }
  if (target.hasAttribute('data-suggest-query')) { suggestQuerySettings(); return; }
  if (target.dataset.removeRelation) {
    app.draft.relations = (app.draft.relations || []).filter(item => relationKey(item) !== target.dataset.removeRelation);
    if (app.draft.relation_docs) delete app.draft.relation_docs[target.dataset.removeRelation];
    render(); return;
  }
  if (target.hasAttribute('data-save-model')) { saveModel(); return; }
  if (target.hasAttribute('data-test-model')) { testModel(); return; }
  if (target.hasAttribute('data-clear-chat')) { app.messages = []; app.pendingQuestion = ''; render(); }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'scope-filter') {
    app.tableFilter = target.value;
    refreshScopeRows();
    return;
  }
  if (target.id === 'meta-filter') {
    app.metaFilter = target.value;
    const list = $('#meta-table-list');
    if (list) list.innerHTML = renderMetadataTableList(app.draft, includedTables());
    return;
  }
  if (target.dataset.sqlEdit) {
    const message = app.messages.find(m => m.id === target.dataset.sqlEdit);
    if (message) message.sql = target.value;
    return;
  }
  if (!app.draft) return;
  if (target.dataset.meta) app.draft[target.dataset.meta] = target.value;
  if (target.dataset.tableDoc) {
    app.draft.table_docs ||= {};
    app.draft.table_docs[target.dataset.tableDoc] = target.value;
  }
  if (target.dataset.tableBusiness) {
    app.draft.table_business_names ||= {};
    app.draft.table_business_names[target.dataset.tableBusiness] = target.value;
  }
  if (target.dataset.tablePurpose) {
    app.draft.table_purposes ||= {};
    app.draft.table_purposes[target.dataset.tablePurpose] = target.value;
  }
  if (target.dataset.columnDoc) {
    app.draft.column_docs ||= {};
    app.draft.column_docs[target.dataset.tableName] ||= {};
    app.draft.column_docs[target.dataset.tableName][target.dataset.columnDoc] = target.value;
  }
  if (target.dataset.columnBusiness) {
    app.draft.column_business_names ||= {};
    app.draft.column_business_names[target.dataset.tableName] ||= {};
    app.draft.column_business_names[target.dataset.tableName][target.dataset.columnBusiness] = target.value;
  }
  if (target.dataset.columnValues) {
    app.draft.column_value_hints ||= {};
    app.draft.column_value_hints[target.dataset.tableName] ||= {};
    app.draft.column_value_hints[target.dataset.tableName][target.dataset.columnValues] = target.value;
  }
  if (target.dataset.relationDescription) {
    app.draft.relation_docs ||= {};
    app.draft.relation_docs[target.dataset.relationDescription] ||= { cardinality: '未知', description: '' };
    app.draft.relation_docs[target.dataset.relationDescription].description = target.value;
  }
  if (target.dataset.tableDoc || target.dataset.tableBusiness || target.dataset.tablePurpose
    || target.dataset.columnDoc || target.dataset.columnBusiness) refreshMetadataProgress();
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.hasAttribute('data-source-switch')) {
    app.sourceId = target.value;
    app.tableFilter = '';
    app.messages = [];
    app.pendingQuestion = '';
    const selected = app.sources.find(s => s.id === app.sourceId);
    if (selected && !selected.connected) {
      app.schema = []; app.meta = selected; app.draft = JSON.parse(JSON.stringify(selected));
      app.scopeDraft = new Set(selected.included_tables || []); render();
    } else {
      try { await loadSchema(); } catch (error) { toast(error.message); }
    }
    return;
  }
  if (target.id === 'meta-status') {
    app.metaStatus = target.value;
    const list = $('#meta-table-list');
    if (list) list.innerHTML = renderMetadataTableList(app.draft, includedTables());
    return;
  }
  if (target.id === 'rel-from-table' || target.id === 'rel-to-table') {
    const side = target.id === 'rel-from-table' ? 'from' : 'to';
    if (side === 'from') app.relationFromTable = target.value;
    else app.relationToTable = target.value;
    const table = includedTables().find(item => item.name === target.value);
    const columnSelect = $(`#rel-${side}-col`);
    if (table && columnSelect) columnSelect.innerHTML = table.columns.map(column =>
      `<option value="${esc(column.name)}">${esc(column.name)}</option>`).join('');
    return;
  }
  if (target.dataset.relationCardinality && app.draft) {
    app.draft.relation_docs ||= {};
    app.draft.relation_docs[target.dataset.relationCardinality] ||= { cardinality: '未知', description: '' };
    app.draft.relation_docs[target.dataset.relationCardinality].cardinality = target.value;
    return;
  }
  if (target.dataset.querySetting && app.draft) {
    const setting = ensureQuerySetting(app.draft, target.dataset.tableName);
    setting[target.dataset.querySetting] = target.dataset.querySetting === 'default_limit'
      ? Math.max(1, Math.min(200, Number(target.value || 100))) : target.value;
    refreshMetadataProgress();
    return;
  }
  if (target.dataset.queryList && app.draft) {
    const setting = ensureQuerySetting(app.draft, target.dataset.tableName);
    const values = new Set(setting[target.dataset.queryList] || []);
    if (target.checked) values.add(target.value); else values.delete(target.value);
    setting[target.dataset.queryList] = [...values];
    refreshMetadataProgress();
    return;
  }
  if (target.dataset.scopeTable) {
    if (target.checked) app.scopeDraft.add(target.dataset.scopeTable);
    else app.scopeDraft.delete(target.dataset.scopeTable);
    const row = target.closest('.live-scope-row');
    if (row) {
      row.classList.toggle('selected', target.checked);
      const status = row.querySelector('.live-scope-state');
      if (status) status.textContent = target.checked ? '已勾选' : '未勾选';
    }
    updateScopeSummary();
    return;
  }
  if (target.dataset.sensitive && app.draft) {
    const id = `${target.dataset.tableName}.${target.dataset.sensitive}`;
    const values = new Set(app.draft.sensitive_columns || []);
    if (target.checked) values.add(id); else values.delete(id);
    app.draft.sensitive_columns = [...values];
    if (target.checked) {
      const setting = ensureQuerySetting(app.draft, target.dataset.tableName);
      for (const field of ['entity_key', 'time_field', 'sort_field']) {
        if (setting[field] === target.dataset.sensitive) setting[field] = '';
      }
      for (const field of ['default_fields', 'filterable_fields']) {
        setting[field] = (setting[field] || []).filter(value => value !== target.dataset.sensitive);
      }
    }
    refreshMetadataProgress();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key === 'Enter' && event.target.id === 'question-input') {
    event.preventDefault();
    askQuestion();
  }
});

refreshStatus().catch(error => {
  $('#app').innerHTML = `<div class="main"><div class="alert danger">${esc(error.message)}</div></div>`;
});
