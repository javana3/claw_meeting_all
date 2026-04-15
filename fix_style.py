#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
sys.stdout.reconfigure(encoding='utf-8')

files_to_fix = [
    'README.ja.md',
    'README.ko.md',
    'README.zh-CN.md',
    'README.zh-TW.md',
]

style_block = """
    style [*] fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style Collecting fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style FastPath fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Scoring fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Confirming fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Committed fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Failed fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Expired fill:#eff6ff,stroke:#2563eb,color:#1e3a8a"""

for filename in files_to_fix:
    print(f"Processing {filename}...")
    try:
        with open(filename, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()

        # Check if style block already exists
        if 'style [*] fill:#dbeafe' in content:
            print(f"  Already has style block, skipping")
            continue

        lines = content.split('\n')
        new_lines = []
        i = 0
        changes = 0
        while i < len(lines):
            new_lines.append(lines[i])

            # Check if this line ends with --> [*]: something and next line is ```
            line = lines[i]
            next_line = lines[i+1] if i+1 < len(lines) else ""

            if next_line.strip() == '```' and '-->' in line and '[*]' in line:
                # Insert style block before ```
                new_lines.append(style_block)
                changes += 1
                print(f"  Added style block after line {i+1}: {repr(line[:50])}")

            i += 1

        if changes > 0:
            with open(filename, 'w', encoding='utf-8') as f:
                f.write('\n'.join(new_lines))
            print(f"  Fixed {filename} with {changes} changes")
        else:
            print(f"  No changes needed for {filename}")

    except Exception as e:
        print(f"  Error with {filename}: {e}")