@echo off
REM call this from $repo/Software
REM Uses MSBuild from PATH if available (e.g. a VS developer prompt / CI),
REM otherwise locates the newest Visual Studio installation via vswhere.
REM Extra MSBuild arguments can be passed via UPDATEELEVATE_MSBUILD_ARGS
REM (e.g. set UPDATEELEVATE_MSBUILD_ARGS=/p:PlatformToolset=v143)

where MSBuild.exe >nul 2>nul
if %ERRORLEVEL% neq 0 (
	for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.Component.MSBuild -property installationPath`) do (
		set "VSINSTALL=%%i"
	)
)
if defined VSINSTALL call "%VSINSTALL%\Common7\Tools\VsDevCmd.bat"

MSBuild.exe UpdateElevate\UpdateElevate.sln /p:Configuration=Release %UPDATEELEVATE_MSBUILD_ARGS%
