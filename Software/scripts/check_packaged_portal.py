"""Check the portal resources and QtWebSockets dependency in a package binary."""

import argparse
from pathlib import Path


def check_portal(executable: Path, platform: str) -> None:
    contents = executable.read_bytes()
    if platform == "windows-qt6":
        library = "Qt6WebSockets.dll"
        if not (executable.parent / library).is_file():
            raise ValueError(f"missing package input: {library}")
    else:
        library = "libQt5WebSockets.so.5"

    if library.encode("ascii").lower() + b"\0" not in contents.lower():
        raise ValueError(f"the executable does not reference {library}")

    # rcc writes each resource name as big-endian UTF-16, regardless of the platform.
    for name in ("www", "index.html", "app.css", "app.js"):
        if name.encode("utf-16-be") not in contents:
            raise ValueError(f"missing embedded portal resource: {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("platform", choices=("linux-qt5", "windows-qt6"))
    arguments = parser.parse_args()
    try:
        check_portal(arguments.binary, arguments.platform)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    print("Portal resources and QtWebSockets found")


if __name__ == "__main__":
    main()
