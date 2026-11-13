# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules


project_root = Path(SPECPATH)
app_root = project_root / "local_app"
vendor_root = app_root / "vendor"
if vendor_root.is_dir():
    sys.path.insert(0, str(vendor_root))

hidden_imports = []
for package in ("pymysql", "sqlglot", "cryptography", "cffi", "pycparser"):
    hidden_imports.extend(collect_submodules(package))

data_files = [
    (str(app_root / "index.html"), "."),
    (str(app_root / "app.js"), "."),
    (str(app_root / "style.css"), "."),
]
if vendor_root.is_dir():
    data_files.append((str(vendor_root), "vendor"))

a = Analysis(
    [str(app_root / "server.py")],
    pathex=[str(app_root), str(vendor_root)],
    binaries=[],
    datas=data_files,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "unittest", "test", "tests"],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="NL2SQL本地工作台",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="NL2SQL-Workbench-Windows-x64",
)
