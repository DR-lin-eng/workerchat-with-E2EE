@echo off
echo 正在部署大文件传输修复...
echo.

echo 1. 检查 TypeScript 编译...
npx tsc --noEmit
if %errorlevel% neq 0 (
    echo TypeScript 编译检查失败！
    pause
    exit /b 1
)

echo 2. 部署到 Cloudflare Workers...
npm run deploy
if %errorlevel% neq 0 (
    echo 部署失败！
    pause
    exit /b 1
)

echo.
echo ✅ 部署成功！
echo.
echo 修复内容：
echo - 实时文件传输无文件大小限制
echo - 单个分片最大500MB
echo - 动态分片大小优化
echo - 支持超大文件传输
echo.
echo 测试页面：
echo - /test-large-file.html - 大文件传输测试工具
echo - /realtime.html - 实时文件传输页面
echo.
pause