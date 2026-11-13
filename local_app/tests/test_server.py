import base64
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class LocalWorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.patches = [
            patch.object(server, "DATA_DIR", self.root / "data"),
            patch.object(server, "SOURCE_DIR", self.root / "data" / "sources"),
            patch.object(server, "CONFIG_FILE", self.root / "data" / "config.json"),
        ]
        for item in self.patches:
            item.start()
        self.addCleanup(self.cleanup)
        db = self.root / "orders.sqlite"
        conn = sqlite3.connect(db)
        conn.executescript("""
            CREATE TABLE orders (id INTEGER PRIMARY KEY, region TEXT, amount REAL, secret TEXT);
            INSERT INTO orders VALUES (1, '华东', 100.5, 'hidden');
            INSERT INTO orders VALUES (2, '华北', 40.0, 'hidden');
        """)
        conn.close()
        result = server.import_source({
            "name": "测试订单", "filename": "orders.sqlite",
            "data": base64.b64encode(db.read_bytes()).decode("ascii"),
        })
        self.source_id = result["source"]["id"]
        self.source = server.source_for(server.load_config(), self.source_id)

    def cleanup(self):
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def test_real_schema_and_result(self):
        schema = server.inspect_schema(self.source)
        self.assertEqual([t["name"] for t in schema], ["orders"])
        self.assertEqual(len(schema[0]["columns"]), 4)
        result = server.execute_sql({"source_id": self.source_id, "sql": "SELECT region, SUM(amount) AS total FROM orders GROUP BY region ORDER BY region"})
        self.assertEqual(result["rows"], [["华东", 100.5], ["华北", 40.0]])

    def test_readonly_and_sensitive_column_guards(self):
        server.update_metadata({
            "source_id": self.source_id, "description": "订单",
            "glossary": "销售额为 amount", "table_docs": {"orders": "订单"},
            "column_docs": {"orders": {"amount": "销售金额"}},
            "sensitive_columns": ["orders.secret"],
        })
        source = server.source_for(server.load_config(), self.source_id)
        for sql in (
            "UPDATE orders SET amount = 0",
            "SELECT secret FROM orders",
            "SELECT load_extension('bad')",
            "SELECT * FROM sqlite_master",
            "SELECT id FROM orders; DELETE FROM orders",
        ):
            with self.subTest(sql=sql), self.assertRaises(server.AppError):
                server.validate_sql(source, sql)
        self.assertIn("销售金额", server.render_schema("销售金额", source, server.inspect_schema(source))[0])
        self.assertNotIn("secret", server.render_schema("销售金额", source, server.inspect_schema(source))[0])

    def test_csv_import_infers_numeric_values(self):
        raw = "地区,金额\n华东,12.5\n华北,9\n".encode("utf-8-sig")
        result = server.import_source({
            "filename": "区域数据.csv", "data": base64.b64encode(raw).decode("ascii")
        })
        source_id = result["source"]["id"]
        query = server.execute_sql({"source_id": source_id, "sql": 'SELECT SUM("金额") FROM "区域数据"'})
        self.assertEqual(query["rows"], [[21.5]])

    def test_generated_sql_is_checked_before_returning(self):
        response = {
            "sql": "SELECT COUNT(*) AS total FROM orders", "need_clarification": False,
            "rationale": "统计订单数", "used_tables": ["orders"], "confidence": 0.9,
            "used_terms": ["订单数量"], "assumptions": ["每行代表一笔订单"],
        }
        with patch.object(server, "call_model", return_value=json.dumps(response, ensure_ascii=False)) as model:
            result = server.generate_sql({"source_id": self.source_id, "question": "有多少订单？"})
        self.assertEqual(result["sql"], response["sql"])
        self.assertEqual(result["selected_tables"], ["orders"])
        self.assertEqual(result["used_terms"], ["订单数量"])
        self.assertEqual(result["assumptions"], ["每行代表一笔订单"])
        messages = model.call_args.args[0]
        self.assertIn("业务口径", messages[0]["content"])
        self.assertIn("不得猜测", messages[0]["content"])
        prompt_data = json.loads(messages[1]["content"])
        self.assertEqual(prompt_data["user_question"], "有多少订单？")
        self.assertIn("表 orders", prompt_data["schema_context"])

    def test_model_string_false_is_not_treated_as_clarification(self):
        response = {"sql": "SELECT COUNT(*) FROM orders", "need_clarification": "false",
                    "rationale": "统计订单数", "used_tables": ["orders"]}
        with patch.object(server, "call_model", return_value=json.dumps(response)), \
             patch.object(server, "validate_sql", side_effect=lambda _source, sql: sql):
            result = server.generate_sql({"source_id": self.source_id, "question": "有多少订单？"})
        self.assertFalse(result["need_clarification"])
        self.assertEqual(result["sql"], response["sql"])

    def test_validation_repair_can_ask_for_clarification(self):
        first = {"sql": "SELECT missing FROM orders", "need_clarification": False,
                 "rationale": "字段待核对", "used_tables": ["orders"], "confidence": 0.3}
        repaired = {"sql": None, "need_clarification": True,
                    "clarification_question": "请问要统计订单数量还是金额？",
                    "clarification_options": ["订单数量", "订单金额"]}
        with patch.object(server, "call_model", side_effect=[json.dumps(first), json.dumps(repaired)]) as model:
            result = server.generate_sql({"source_id": self.source_id, "question": "查询订单指标"})
        self.assertTrue(result["need_clarification"])
        self.assertEqual(result["clarification_question"], repaired["clarification_question"])
        self.assertEqual(result["clarification_options"], repaired["clarification_options"])
        self.assertIn("只修复错误直接指出", model.call_args.args[0][-1]["content"])

    def test_mysql_ast_rejects_writes_locks_unknown_tables_and_sensitive_columns(self):
        mysql_source = {"type": "mysql", "database": "sales", "sensitive_columns": ["orders.secret"],
                        "included_tables": ["orders"]}
        schema = [{"name": "orders", "kind": "table", "description": "", "columns": [], "foreign_keys": []}]
        with patch.object(server, "inspect_schema", return_value=schema):
            server.validate_ast(mysql_source, "SELECT COUNT(*) FROM orders")
            server.validate_ast(mysql_source, "WITH x AS (SELECT id FROM orders) SELECT COUNT(*) FROM x")
            for sql in (
                "SELECT * FROM orders", "SELECT secret FROM orders",
                "SELECT id FROM orders FOR UPDATE", "SELECT SLEEP(5) FROM orders",
                "SELECT @@version", "SELECT CURRENT_USER()", "SELECT DATABASE()",
                "SELECT id FROM otherdb.orders", "SELECT id FROM other_table",
                "WITH orders AS (SELECT secret FROM sales.orders) SELECT secret FROM orders",
                "SELECT id FROM orders; DELETE FROM orders",
            ):
                with self.subTest(sql=sql), self.assertRaises(server.AppError):
                    server.validate_ast(mysql_source, sql)

        for sql in ("SELECT 1 /*!50000 UNION SELECT secret FROM orders */",
                    "SELECT 1 /*M! UNION SELECT secret FROM orders */"):
            with self.subTest(sql=sql), self.assertRaisesRegex(server.AppError, "可执行注释"):
                server.validate_sql(mysql_source, sql)

    def test_mysql_password_is_kept_out_of_config_file(self):
        class FakeCursor:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def execute(self, *_): pass
            def fetchone(self): return (2,)
            def fetchall(self): return [("orders",), ("customers",)]

        class FakeConnection:
            def cursor(self): return FakeCursor()
            def close(self): pass

        with patch.object(server, "mysql_connection", return_value=FakeConnection()):
            result = server.connect_mysql_source({
                "name": "MySQL 测试", "host": "127.0.0.1", "port": 3306,
                "database": "sales", "user": "read_only", "password": "topsecret",
            })
        mysql_id = result["source"]["id"]
        self.addCleanup(lambda: server.MYSQL_PASSWORDS.pop(mysql_id, None))
        self.assertNotIn("topsecret", server.CONFIG_FILE.read_text(encoding="utf-8"))
        self.assertEqual(server.MYSQL_PASSWORDS[mysql_id], "topsecret")
        self.assertEqual(result["source"]["type"], "mysql")
        self.assertEqual(result["source"]["included_tables"], [])

    def test_mysql_scope_is_required_and_excluded_tables_are_blocked(self):
        columns = [{"name": "id", "type": "int", "primary_key": True,
                    "description": "", "sensitive": False}]
        schema = [
            {"name": "orders", "kind": "table", "description": "订单", "columns": columns, "foreign_keys": []},
            {"name": "payroll", "kind": "table", "description": "薪资", "columns": columns, "foreign_keys": []},
        ]
        source = {"type": "mysql", "name": "销售", "database": "sales", "sensitive_columns": []}
        with patch.object(server, "inspect_schema", return_value=schema):
            with self.assertRaises(server.AppError):
                server.validate_ast(source, "SELECT COUNT(*) FROM orders")
            source["included_tables"] = ["orders"]
            server.validate_ast(source, "SELECT COUNT(*) FROM orders")
            with self.assertRaises(server.AppError):
                server.validate_ast(source, "SELECT COUNT(*) FROM payroll")
            context, used = server.render_schema("订单量", source, server.scoped_schema(source, schema))
        self.assertIn("orders", context)
        self.assertNotIn("payroll", context)
        self.assertEqual(used, ["orders"])

    def test_mysql_scope_save_validates_table_names_and_persists(self):
        mysql_id = "mysql_scope_test"
        item = {"id": mysql_id, "name": "测试", "type": "mysql", "host": "localhost",
                "port": 3306, "database": "sales", "user": "reader", "included_tables": []}
        config = server.load_config()
        config["sources"].append(item)
        server.save_config(config)
        server.MYSQL_PASSWORDS[mysql_id] = ""
        self.addCleanup(lambda: server.MYSQL_PASSWORDS.pop(mysql_id, None))
        schema = [{"name": "orders", "kind": "table", "description": "", "columns": [], "foreign_keys": []}]
        with patch.object(server, "inspect_schema", return_value=schema):
            with self.assertRaises(server.AppError):
                server.update_table_scope({"source_id": mysql_id, "included_tables": ["unknown"]})
            saved = server.update_table_scope({"source_id": mysql_id, "included_tables": ["orders", "orders"]})
        self.assertEqual(saved["included_tables"], ["orders"])
        self.assertEqual(server.source_for(server.load_config(), mysql_id)["included_tables"], ["orders"])

    def test_mysql_1045_explains_authentication_failure_without_echoing_password(self):
        source = {"id": "test", "host": "127.0.0.1", "port": 3306,
                  "user": "read_only", "database": "sales"}
        error = server.pymysql.OperationalError(1045, "Access denied for user 'read_only'@'host'")
        with patch.object(server.pymysql, "connect", side_effect=error):
            with self.assertRaises(server.AppError) as caught:
                server.mysql_connection(source, "private-password")
        self.assertIn("1045", str(caught.exception))
        self.assertIn("来源地址", str(caught.exception))
        self.assertNotIn("private-password", str(caught.exception))

    def test_manual_relationship_is_validated_and_added_to_schema(self):
        conn = sqlite3.connect(server.source_path(self.source))
        conn.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)")
        conn.commit()
        conn.close()
        saved = server.update_metadata({
            "source_id": self.source_id,
            "relations_text": "orders.id = customers.id",
        })
        self.assertEqual(len(saved["relations"]), 1)
        refreshed = server.source_for(server.load_config(), self.source_id)
        orders = next(t for t in server.inspect_schema(refreshed) if t["name"] == "orders")
        self.assertIn({"from": "id", "to_table": "customers", "to": "id", "origin": "manual"},
                      orders["foreign_keys"])
        with self.assertRaises(server.AppError):
            server.update_metadata({"source_id": self.source_id, "relations_text": "orders.missing = customers.id"})

    def test_business_metadata_and_relationship_notes_reach_model_context(self):
        conn = sqlite3.connect(server.source_path(self.source))
        conn.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)")
        conn.commit()
        conn.close()
        key = "orders.id=customers.id"
        server.update_metadata({
            "source_id": self.source_id,
            "description": "销售数据", "glossary": "金额以元为单位",
            "table_business_names": {"orders": "订单主表"},
            "table_docs": {"orders": "一行是一笔订单"},
            "table_purposes": {"orders": "用于分析地区订单金额"},
            "column_business_names": {"orders": {"amount": "实付金额"}},
            "column_docs": {"orders": {"amount": "支付后金额"}},
            "column_value_hints": {"orders": {"amount": "单位：元"}},
            "table_query_settings": {"orders": {
                "entity_key": "id", "time_field": "", "sort_field": "id",
                "sort_direction": "DESC", "default_limit": 50,
                "default_fields": ["id", "region", "amount"],
                "filterable_fields": ["region"],
            }},
            "sensitive_columns": [],
            "relations": [{"from_table": "orders", "from_col": "id",
                           "to_table": "customers", "to_col": "id"}],
            "relation_docs": {key: {"cardinality": "N:1", "description": "按客户编号关联"}},
        })
        source = server.source_for(server.load_config(), self.source_id)
        context, _ = server.render_schema("订单金额", source, server.inspect_schema(source))
        for phrase in ("订单主表", "一行是一笔订单", "用于分析地区订单金额", "实付金额",
                       "支付后金额", "单位：元", "N:1", "按客户编号关联",
                       "明细查询默认设置", "默认展示字段=id,region,amount", "默认条数=50"):
            self.assertIn(phrase, context)

    def test_detail_query_settings_are_validated_and_sensitive_fields_removed(self):
        saved = server.update_metadata({
            "source_id": self.source_id,
            "sensitive_columns": ["orders.secret"],
            "table_query_settings": {"orders": {
                "entity_key": "id", "time_field": "secret", "sort_field": "id",
                "sort_direction": "DESC", "default_limit": 100,
                "default_fields": ["id", "region", "secret"],
                "filterable_fields": ["region", "secret"],
            }},
        })
        setting = saved["table_query_settings"]["orders"]
        self.assertEqual(setting["default_fields"], ["id", "region"])
        self.assertEqual(setting["filterable_fields"], ["region"])
        self.assertEqual(setting["time_field"], "")
        with self.assertRaises(server.AppError):
            server.update_metadata({"source_id": self.source_id, "table_query_settings": {
                "orders": {"default_limit": 201, "default_fields": [], "filterable_fields": []}
            }})

    def test_real_model_metadata_draft_is_a_reviewable_unsaved_result(self):
        response = {"business_name": "订单表", "explanation": "一行一笔订单", "purpose": "统计订单"}
        with patch.object(server, "call_model", return_value=json.dumps(response, ensure_ascii=False)) as model:
            draft = server.draft_metadata({"source_id": self.source_id, "table": "orders", "mode": "table"})
        self.assertEqual(draft["business_name"], "订单表")
        self.assertIn("orders", model.call_args.args[0][1]["content"])
        self.assertFalse(server.source_for(server.load_config(), self.source_id).get("table_business_names"))
        with patch.object(server, "call_model", return_value=json.dumps({"columns": {
            "amount": {"business_name": "金额", "description": "实付", "value_hint": "元"}}}, ensure_ascii=False)):
            columns = server.draft_metadata({"source_id": self.source_id, "table": "orders",
                                             "mode": "columns", "column_names": ["amount"]})
        self.assertEqual(columns["columns"]["amount"]["description"], "实付")

    def test_sensitive_relationship_column_is_not_sent_to_model(self):
        conn = sqlite3.connect(server.source_path(self.source))
        conn.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)")
        conn.commit()
        conn.close()
        server.update_metadata({
            "source_id": self.source_id,
            "relations_text": "orders.secret = customers.name",
            "sensitive_columns": ["orders.secret"],
        })
        source = server.source_for(server.load_config(), self.source_id)
        context, _ = server.render_schema("客户数量", source, server.inspect_schema(source))
        self.assertNotIn("orders.secret", context)
        self.assertNotIn("secret", context)

    def test_table_recall_keeps_visible_columns_after_sensitive_prefix(self):
        columns = [{"name": f"secret_{index}", "description": "", "business_name": "",
                    "sensitive": True} for index in range(18)]
        columns.append({"name": "public_metric", "description": "公开指标", "business_name": "指标",
                        "sensitive": False})
        schema = [{"name": "facts", "description": "事实表", "business_name": "", "purpose": "",
                   "columns": columns, "foreign_keys": []}]
        answer = json.dumps({"tables": ["facts"], "need_clarification": False})
        with patch.object(server, "call_model", return_value=answer) as model:
            names, clarification, options = server.choose_tables_with_model("公开指标", schema)
        catalog = json.loads(model.call_args.args[0][1]["content"])["candidate_tables"]
        self.assertEqual(names, ["facts"])
        self.assertFalse(clarification)
        self.assertEqual(options, [])
        self.assertIn("public_metric", catalog[0])
        self.assertNotIn("secret_0", catalog[0])

    def test_http_generate_and_execute_route(self):
        http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (http.shutdown(), http.server_close(), thread.join(timeout=2)))
        base = f"http://127.0.0.1:{http.server_port}"

        def post(route, body):
            req = urllib.request.Request(base + route, data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json", "X-Local-App": "1"}, method="POST")
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.load(response)

        response = {"sql": "SELECT COUNT(*) FROM orders", "need_clarification": False,
                    "rationale": "统计订单数", "used_tables": ["orders"]}
        with patch.object(server, "call_model", return_value=json.dumps(response, ensure_ascii=False)):
            generated = post("/api/generate", {"source_id": self.source_id, "question": "订单有多少？"})
        self.assertEqual(generated["sql"], "SELECT COUNT(*) FROM orders")
        executed = post("/api/execute", {"source_id": self.source_id, "sql": generated["sql"]})
        self.assertEqual(executed["rows"], [[2]])

    def test_model_uses_real_chat_completions_http_contract(self):
        seen = {}

        class FakeModel(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                seen["path"] = self.path
                seen["authorization"] = self.headers.get("Authorization")
                seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                choice = {"message": {"content": None if seen.get("truncate") else "OK"},
                          "finish_reason": "length" if seen.get("truncate") else "stop"}
                raw = json.dumps({"choices": [choice]}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        http = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (http.shutdown(), http.server_close(), thread.join(timeout=2)))
        old = server.MODEL.copy()
        self.addCleanup(lambda: server.MODEL.update(old))
        server.MODEL.update({"base_url": f"http://127.0.0.1:{http.server_port}/v1",
                             "model": "test-model", "api_key": "example-key", "timeout": 5})
        self.assertEqual(server.call_model([{"role": "user", "content": "test"}]), "OK")
        self.assertEqual(seen["path"], "/v1/chat/completions")
        self.assertEqual(seen["authorization"], "Bearer example-key")
        self.assertEqual(seen["body"]["model"], "test-model")
        self.assertEqual(seen["body"]["max_tokens"], 8192)
        with patch.object(server.urllib.request, "getproxies", return_value={"http": "http://127.0.0.1:9"}), \
             patch.object(server.urllib.request, "urlopen",
                          side_effect=server.urllib.error.URLError(ConnectionRefusedError())):
            self.assertEqual(server.call_model([{"role": "user", "content": "test"}]), "OK")
        server.update_model({"base_url": f"http://127.0.0.1:{http.server_port}/v1",
                             "model": "test-model", "max_tokens": 16384})
        self.assertEqual(server.call_model([{"role": "user", "content": "test"}]), "OK")
        self.assertEqual(seen["body"]["max_tokens"], 16384)
        seen["truncate"] = True
        with self.assertRaisesRegex(server.AppError, "16384 Token"):
            server.call_model([{"role": "user", "content": "test"}])
        with patch.object(server.urllib.request, "urlopen", side_effect=server.socket.timeout("slow")):
            with self.assertRaisesRegex(server.AppError, "模型响应超时"):
                server.call_model([{"role": "user", "content": "test"}])

    def test_ten_tables_within_prompt_budget_skip_model_table_recall(self):
        schema = [{"name": f"table_{index}", "kind": "table", "description": "业务说明" * 380,
                   "business_name": "", "purpose": "", "foreign_keys": [],
                   "columns": [{"name": "id", "type": "INTEGER", "description": "编号",
                                "business_name": "", "value_hint": "", "primary_key": True,
                                "sensitive": False}]}
                  for index in range(10)]
        answer = json.dumps({"sql": "SELECT COUNT(*) FROM table_0", "need_clarification": False,
                             "used_tables": ["table_0"], "rationale": "计数", "confidence": 0.8})
        with patch.object(server, "inspect_schema", return_value=schema), \
             patch.object(server, "choose_tables_with_model", side_effect=AssertionError("unneeded recall")), \
             patch.object(server, "call_model", return_value=answer), \
             patch.object(server, "validate_sql", side_effect=lambda _source, sql: sql):
            result = server.generate_sql({"source_id": self.source_id, "question": "有多少条记录？"})
        self.assertEqual(len(result["selected_tables"]), 10)

    def test_mysql_execution_uses_readonly_transaction_and_row_cap(self):
        commands = []

        class FakeCursor:
            description = [("id",)]
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def execute(self, command): commands.append(command)
            def fetchmany(self, _): return [(1,)]

        class FakeConnection:
            def cursor(self): return FakeCursor()
            def close(self): pass

        with patch.object(server, "mysql_connection", return_value=FakeConnection()):
            result = server.execute_mysql({"type": "mysql"}, "SELECT id FROM orders")
        self.assertEqual(result["rows"], [[1]])
        self.assertEqual(commands[0], "SET SESSION MAX_EXECUTION_TIME = 8000")
        self.assertEqual(commands[1], "START TRANSACTION READ ONLY")
        self.assertTrue(commands[2].endswith("LIMIT 201"))


if __name__ == "__main__":
    unittest.main()
