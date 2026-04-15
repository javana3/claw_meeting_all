#!/usr/bin/env python3
# -*- coding: utf-8 -*-

with open('README.zh-CN.md', 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

print(f"Has style block: {'style [*]' in content}")

lines = content.split('\n')
for i, line in enumerate(lines):
    if 'Expired' in line or '过期' in line or '만료' in line or '期限' in line:
        if '[*]' in line:
            print(f"Line {i}: {repr(line)}")
            print(f"Next line {i+1}: {repr(lines[i+1])}")