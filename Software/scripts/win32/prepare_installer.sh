#!/bin/bash
# call this from $repo/Software
set -e

# build UpdateElevate
echo "#define NAME L\"Prismatik\"" > UpdateElevate/UpdateElevate/command.h
echo "#define EXT L\".exe\"" >> UpdateElevate/UpdateElevate/command.h
echo "#define ARGS L\" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART\"" >> UpdateElevate/UpdateElevate/command.h
cmd //c scripts\\win32\\build_UpdateElevate.bat
cp UpdateElevate/x64/Release/UpdateElevate.exe dist_windows/content/



cp bin/*.dll dist_windows/content/
cp bin/*.exe dist_windows/content/

cp -r bin/platforms dist_windows/content/
cp -r bin/styles dist_windows/content/
cp -r bin/tls dist_windows/content/

# Newer windeployqt (Qt 6.8+) no longer deploys the OpenSSL TLS backend by default,
# but the installer (and the HTTPS update check) needs it. Take it from the Qt install.
if [ ! -f dist_windows/content/tls/qopensslbackend.dll ]; then
	QT_BASE="${QT_ROOT_DIR:-$QTDIR}"
	if [ -n "$QT_BASE" ] && [ -f "$(cygpath -u "$QT_BASE")/plugins/tls/qopensslbackend.dll" ]; then
		mkdir -p dist_windows/content/tls
		cp "$(cygpath -u "$QT_BASE")/plugins/tls/qopensslbackend.dll" dist_windows/content/tls/
	else
		echo "qopensslbackend.dll not found (set QT_ROOT_DIR or QTDIR to the Qt install)" >&2
		exit 1
	fi
fi
