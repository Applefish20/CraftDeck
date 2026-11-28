"""打包 zip（使用正斜杠路径，兼容 Windows 资源管理器 / 7-Zip / macOS / Linux）。
用法：
  python scripts/pack-zip.py <源目录> <输出 zip> [要排除的绝对路径 ...]
"""
import os
import sys
import zipfile


def main():
    if len(sys.argv) < 3:
        print('usage: pack-zip.py <src> <out.zip> [exclude ...]')
        return 1
    src = os.path.abspath(sys.argv[1])
    out = os.path.abspath(sys.argv[2])
    excludes = {os.path.abspath(p) for p in sys.argv[3:]}
    if os.path.exists(out):
        os.remove(out)
    count = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for root, dirs, files in os.walk(src):
            dirs[:] = [d for d in dirs if os.path.abspath(os.path.join(root, d)) not in excludes]
            for name in files:
                p = os.path.join(root, name)
                if os.path.abspath(p) in excludes:
                    continue
                arc = os.path.relpath(p, src).replace(os.sep, '/')
                try:
                    z.write(p, arc)
                    count += 1
                except PermissionError:
                    pass
    size = os.path.getsize(out) / 1048576
    print(f'{count} files -> {out} ({size:.1f} MB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
