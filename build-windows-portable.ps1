$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distRoot = Join-Path $projectRoot "dist"
$packageRoot = Join-Path $distRoot "NL2SQL-Workbench-Windows-x64"
$zipPath = Join-Path $distRoot "NL2SQL-Workbench-Windows-x64.zip"
$resolvedDistRoot = [IO.Path]::GetFullPath($distRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$resolvedPackageRoot = [IO.Path]::GetFullPath($packageRoot)

if (-not $resolvedPackageRoot.StartsWith($resolvedDistRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Package directory must stay inside the project dist directory."
}

Set-Location $projectRoot
$python = Get-Command "python" -ErrorAction SilentlyContinue
if ($null -ne $python) {
    & $python.Source -m PyInstaller --noconfirm --clean "windows-portable.spec"
} else {
    $launcher = Get-Command "py" -ErrorAction Stop
    & $launcher.Source -3 -m PyInstaller --noconfirm --clean "windows-portable.spec"
}

$builtExe = Get-ChildItem -LiteralPath $packageRoot -Filter "*.exe" | Select-Object -First 1
if ($null -eq $builtExe) {
    throw "PyInstaller did not produce an executable."
}
Copy-Item -LiteralPath (Join-Path $projectRoot "portable-readme.txt") -Destination $packageRoot

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "Package created: $zipPath"
