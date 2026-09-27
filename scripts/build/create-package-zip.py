#!/usr/bin/env python3
"""Create a package ZIP with stable ordering, timestamps, and file modes."""

import os
import shutil
import stat
import sys
import zipfile


def create_package_zip(source_directory, output_path):
    source_directory = os.path.abspath(source_directory)
    output_path = os.path.abspath(output_path)
    files = []
    for root, _, filenames in os.walk(source_directory):
        for filename in filenames:
            file_path = os.path.join(root, filename)
            if filename == '.DS_Store':
                continue
            relative_path = os.path.relpath(file_path, source_directory).replace(os.sep, '/')
            files.append((relative_path, file_path))

    with zipfile.ZipFile(
        output_path,
        mode='w',
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for relative_path, file_path in sorted(files):
            info = zipfile.ZipInfo(relative_path, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            with open(file_path, 'rb') as source, archive.open(info, 'w') as destination:
                shutil.copyfileobj(source, destination, length=1024 * 1024)


if len(sys.argv) != 3:
    raise SystemExit('Usage: create-package-zip.py PACKAGE_DIRECTORY OUTPUT_ZIP')

create_package_zip(sys.argv[1], sys.argv[2])
